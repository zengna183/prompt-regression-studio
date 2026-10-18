import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function connectionEnvironment(raw, restore = false, source = process.env) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("An explicit PostgreSQL connection URL is required");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !/^\/[^/]+$/u.test(url.pathname)
  )
    throw new Error("Invalid PostgreSQL connection URL");
  if (url.hash || [...url.searchParams.keys()].some((key) => key !== "sslmode"))
    throw new Error("Only sslmode is supported in the database URL");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const db = decodeURIComponent(url.pathname.slice(1));
  if (restore && (!local || !/^prs_restore_[a-z0-9_]+$/u.test(db)))
    throw new Error(
      "Restore requires a local, isolated prs_restore_ database; existing deployment databases are never overwritten",
    );
  const sslmode = url.searchParams.get("sslmode") ?? (local ? "prefer" : "verify-full");
  if (
    !["disable", "prefer", "verify-full"].includes(sslmode) ||
    (!local && sslmode !== "verify-full")
  )
    throw new Error("Remote backups require certificate-verified TLS (verify-full)");
  // Discard inherited libpq overrides so PGHOSTADDR/PGSERVICE cannot redirect the target.
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("PG")));
  return {
    ...env,
    PGHOST: url.hostname.replace(/^\[|\]$/gu, ""),
    PGPORT: url.port || "5432",
    PGDATABASE: db,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: sslmode,
    ...(source.BACKUP_SSL_ROOT_CERT ? { PGSSLROOTCERT: source.BACKUP_SSL_ROOT_CERT } : {}),
    PGCONNECT_TIMEOUT: "10",
    PGOPTIONS: "-c statement_timeout=600000 -c lock_timeout=10000",
  };
}

function command(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      child.kill("SIGKILL");
    }, 15 * 60_000);
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-1024 * 1024);
    });
    // PostgreSQL diagnostics can contain identifiers and sensitive SQL. Do not publish them.
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new Error(`Could not start ${path.basename(binary)}; install PostgreSQL client tools`),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(
          new Error(
            `${path.basename(binary)} ${timeout ? "timed out" : `failed (${code})`}; inspect database connectivity, client version and permissions`,
          ),
        );
      else resolve(output.trim());
    });
  });
}
const query = (sql, env) =>
  command(
    process.env.PSQL_BIN || "psql",
    ["-X", "--no-password", "-A", "-t", "--set=ON_ERROR_STOP=on", "-c", sql],
    env,
  );
async function checksum(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function backup(directory, rawUrl) {
  const env = connectionEnvironment(rawUrl);
  const destination = path.resolve(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const temporary = path.join(destination, "database.partial");
  // pg_dump takes a consistent database snapshot even while ordinary writes continue.
  await command(
    process.env.PG_DUMP_BIN || "pg_dump",
    ["--no-password", "--format=custom", "--no-owner", "--no-acl", "--file", temporary],
    env,
  );
  await chmod(temporary, 0o600);
  const archive = path.join(destination, "database.dump");
  await rename(temporary, archive);
  const manifest = {
    format: "prs.database-backup/v1",
    createdAt: new Date().toISOString(),
    archive: "database.dump",
    bytes: (await stat(archive)).size,
    sha256: await checksum(archive),
  };
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return destination;
}

export async function restoreCheck(directory, rawUrl, environment = process.env) {
  const env = connectionEnvironment(rawUrl, true, environment);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (
    manifest.format !== "prs.database-backup/v1" ||
    manifest.archive !== "database.dump" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  )
    throw new Error("Unsupported backup manifest");
  const archive = path.resolve(directory, "database.dump");
  if (
    (await stat(archive)).size !== manifest.bytes ||
    (await checksum(archive)) !== manifest.sha256
  )
    throw new Error("Backup integrity check failed; no restore was attempted");
  const existing = await query(
    "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','v','m','S','f','p')",
    env,
  );
  if (existing !== "0") throw new Error("Restore target is not empty; refusing to overwrite data");
  await command(
    process.env.PG_RESTORE_BIN || "pg_restore",
    [
      "--no-password",
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      "--dbname",
      env.PGDATABASE,
      archive,
    ],
    env,
  );
  // No recovered session or unfinished paid-model task may resume implicitly.
  await query(
    `begin;
    delete from user_sessions;
    update evaluation_runs set status='failed', failure_code='RESTORE_REVIEW_REQUIRED', failure_message='Restored unfinished run requires operator review', completed_at=now() where status in ('queued','running');
    update generation_runs set status='failed', failure_code='RESTORE_REVIEW_REQUIRED', failure_message='Restored unfinished run requires operator review', completed_at=now() where status in ('queued','running');
    update experiments set status='failed', failure_code='RESTORE_REVIEW_REQUIRED', failure_message='Restored unfinished experiment requires operator review', completed_at=now() where status in ('queued','running');
    update evaluation_run_dispatches set status='dispatched', locked_at=null, dispatched_at=now(), updated_at=now() where status in ('pending','dispatching');
    update diagnosis_runs set status='failed', failure_code='RESTORE_REVIEW_REQUIRED', failure_message='Restored unfinished diagnosis requires operator review', completed_at=now() where status='running';
    commit;`,
    env,
  );
  const summary = JSON.parse(
    await query(
      `select json_build_object(
    'projects',(select count(*) from projects),'promptVersions',(select count(*) from prompt_versions),
    'outputs',(select count(*) from generation_outputs),'scores',(select count(*) from scores),
    'reports',(select count(*) from diagnosis_runs where status='succeeded'),
    'activeSessions',(select count(*) from user_sessions),
    'unfinishedRuns',(select count(*) from evaluation_runs where status in ('queued','running')),
    'modelConnections',(select count(*) from model_connections))`,
      env,
    ),
  );
  if (summary.modelConnections > 0) {
    const { decryptModelApiKey, parseModelEncryptionKey } =
      await import("../packages/db/dist/index.js");
    const key = parseModelEncryptionKey(environment.MODEL_ENCRYPTION_KEY);
    const connections = JSON.parse(
      await query(
        "select coalesce(json_agg(json_build_object('id',id,'projectId',project_id,'ciphertext',api_key_ciphertext)),'[]'::json) from model_connections",
        env,
      ),
    );
    for (const item of connections)
      decryptModelApiKey(item.ciphertext, key, item.projectId, item.id);
    summary.modelKeysVerified = connections.length;
  }
  const report = {
    format: "prs.restore-check/v1",
    verifiedAt: new Date().toISOString(),
    backupSha256: manifest.sha256,
    ...summary,
  };
  await writeFile(
    path.join(directory, `restore-report-${randomUUID()}.json`),
    JSON.stringify(report, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, directory] = process.argv.slice(2);
    if (!directory || !["backup", "restore-check"].includes(mode))
      throw new Error("Usage: node scripts/database-backup.mjs backup|restore-check DIRECTORY");
    const result =
      mode === "backup"
        ? await backup(directory, process.env.BACKUP_DATABASE_URL)
        : await restoreCheck(directory, process.env.RESTORE_DATABASE_URL);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
