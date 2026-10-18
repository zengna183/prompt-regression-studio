import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { backup, restoreCheck } from "./database-backup.mjs";
import { createDatabaseClient } from "../packages/db/dist/index.js";

const tables = [
  "projects",
  "prompts",
  "prompt_versions",
  "datasets",
  "dataset_versions",
  "evaluation_cases",
  "evaluation_frameworks",
  "evaluation_framework_versions",
  "generation_outputs",
  "scores",
  "diagnosis_runs",
  "model_connections",
  "users",
  "project_members",
];
async function fingerprints(sql) {
  const result = {};
  for (const table of tables) {
    // Fixed repository-owned identifiers; never user input.
    const [row] = await sql.unsafe(
      `select count(*)::int as count, md5(coalesce(string_agg(hash, '' order by hash),'')) as hash from (select md5(row_to_json(t)::text) as hash from ${table} t) s`,
    );
    result[table] = row;
  }
  return result;
}

export async function verifyBackupRecovery({ database, databaseUrl, encryptionKey, directory }) {
  const before = await fingerprints(database.sql);
  const backupDirectory = await backup(directory, databaseUrl);
  const target = new URL(databaseUrl);
  const name = `prs_restore_${randomUUID().replaceAll("-", "")}`;
  target.pathname = `/${name}`;
  await database.sql.unsafe(`create database ${name}`);
  const restored = createDatabaseClient({
    url: target.href,
    poolMax: 2,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 3,
    ssl: false,
  });
  try {
    const manifestPath = path.join(backupDirectory, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    const corrupt = { ...JSON.parse(original), sha256: "0".repeat(64) };
    await writeFile(manifestPath, JSON.stringify(corrupt));
    await assert.rejects(
      () => restoreCheck(backupDirectory, target.href),
      /integrity check failed/u,
    );
    assert.equal(
      (
        await restored.sql`select count(*)::int as count from information_schema.tables where table_schema='public'`
      )[0].count,
      0,
    );
    await writeFile(manifestPath, original);
    const report = await restoreCheck(backupDirectory, target.href, {
      ...process.env,
      MODEL_ENCRYPTION_KEY: encryptionKey,
    });
    assert.equal(report.activeSessions, 0);
    assert.equal(report.unfinishedRuns, 0);
    assert.equal(report.modelKeysVerified, 1);
    assert.deepEqual(
      await fingerprints(restored.sql),
      before,
      "Restored records differ from the original snapshot",
    );
    const [quarantined] =
      await restored.sql`select count(*)::int as count from evaluation_runs where failure_code='RESTORE_REVIEW_REQUIRED'`;
    assert.equal(quarantined.count, 2);
    const [originalRuns] =
      await database.sql`select count(*)::int as count from evaluation_runs where status='queued'`;
    assert.equal(originalRuns.count, 2, "Restore changed the source database");
    await assert.rejects(() => restoreCheck(backupDirectory, target.href), /not empty/u);
    return {
      ...report,
      comparedTables: tables.length,
      sourceUnchanged: true,
      corruptArchiveRejected: true,
      existingTargetRejected: true,
    };
  } finally {
    await restored.close();
  }
}
