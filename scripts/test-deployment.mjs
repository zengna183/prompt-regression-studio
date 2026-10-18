import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = `prs-acceptance-${randomBytes(6).toString("hex")}`;
const env = {
  ...process.env,
  DATABASE_URL: "postgres://eval:acceptance-only@postgres:5432/prs_deploy_test",
  REDIS_URL: "rediss://redis:6379/15",
  MODEL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  METRICS_AUTH_TOKEN: randomBytes(32).toString("hex"),
  WEB_ORIGIN: "https://acceptance.example.invalid",
  WEB_PORT: "18080",
  PRS_IMAGE_TAG: project,
  AUTH_BOOTSTRAP_EMAIL: "deployment@example.invalid",
  AUTH_BOOTSTRAP_PASSWORD: randomBytes(24).toString("base64url"),
};
const compose = [
  "compose",
  "--project-name",
  project,
  "-f",
  "deploy/compose.yml",
  "-f",
  "deploy/compose.acceptance.yml",
];
const report = { startedAt: new Date().toISOString(), checks: [] };
async function command(binary, args, timeoutMs = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-12000);
      });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${binary} ${args[0]} failed (${code}): ${output}`));
    });
  });
}
const docker = (...args) => command(process.env.DOCKER_CLI_PATH || "docker", args);
const dc = (...args) => docker(...compose, ...args);
const passed = (name) => {
  report.checks.push(name);
  console.log(`PASS ${name}`);
};

try {
  const certs = path.join(root, "artifacts/deployment-certs");
  await mkdir(certs, { recursive: true });
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(certs, "server.key"),
    "-out",
    path.join(certs, "server.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=postgres",
    "-addext",
    "subjectAltName=DNS:postgres,DNS:redis",
  ]);
  await writeFile(path.join(certs, "prs_metrics_token"), env.METRICS_AUTH_TOKEN);
  await dc("config", "--quiet");
  for (const target of ["api", "worker", "web"]) {
    console.log(`Building ${target} deployment image`);
    await docker("build", "--target", target, "--tag", `prs-${target}:${project}`, ".");
  }
  passed("production dependency images build for API, Worker and Web");
  await dc("up", "-d", "--wait", "postgres", "redis");
  await dc("run", "--rm", "-T", "api", "node", "node_modules/@ai-chat-eval/db/dist/migrate.js");
  await dc(
    "run",
    "--rm",
    "-T",
    "-e",
    "AUTH_BOOTSTRAP_EMAIL",
    "-e",
    "AUTH_BOOTSTRAP_PASSWORD",
    "api",
    "node",
    "dist/bootstrap-admin.js",
  );
  await dc("up", "-d", "--wait", "--wait-timeout", "120", "api", "worker", "web");
  passed("production mode starts with certificate-verified PostgreSQL and Redis");
  for (const service of ["api", "worker", "web"])
    assert.notEqual(await dc("exec", "-T", service, "id", "-u"), "0");
  passed("all application containers run without root privileges");
  const origin = "http://127.0.0.1:18080";
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  const html = await page.text();
  assert(html.includes('id="root"'));
  const asset = html.match(/src="([^"]+\.js)"/u)?.[1];
  assert(asset);
  assert.equal((await fetch(new URL(asset, origin))).status, 200);
  assert.equal((await fetch(`${origin}/api/metrics`)).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/projects`)).status, 401);
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: env.AUTH_BOOTSTRAP_EMAIL,
      password: env.AUTH_BOOTSTRAP_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const projectResponse = await fetch(`${origin}/api/v1/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ slug: "container-acceptance", name: "Container acceptance" }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = (await projectResponse.json()).id;
  const bundle = await readFile(
    path.join(root, "examples/missing-information-regression/regression-bundle.json"),
    "utf8",
  );
  const diagnosis = await fetch(`${origin}/api/v1/diagnoses?projectId=${projectId}`, {
    method: "POST",
    headers,
    body: bundle,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(diagnosis.status, 200, await diagnosis.clone().text());
  assert.equal((await diagnosis.json()).schema_version, "prompt-regression.report/v1alpha1");
  passed("static Web, authenticated API and packaged Python diagnosis work through the proxy");
  for (const [service, port, expected] of [
    ["api", 4000, "prs_database_up 1"],
    ["worker", 4101, "prs_worker_ready 1"],
  ]) {
    const output = await dc(
      "exec",
      "-T",
      service,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_AUTH_TOKEN}}).then(r=>r.text()).then(t=>{if(!t.includes('${expected}'))process.exit(1);console.log('healthy')}).catch(()=>process.exit(1))`,
    );
    assert(output.includes("healthy"));
  }
  passed("private authenticated metrics report ready dependencies");
  for (const args of [
    ["check", "rules", "/etc/prometheus/alerts.yml"],
    ["check", "config", "/etc/prometheus/prometheus.yml"],
    ["test", "rules", "/etc/prometheus/alerts.test.yml"],
  ]) {
    await docker(
      "run",
      "--rm",
      "--entrypoint",
      "promtool",
      "--workdir",
      "/etc/prometheus",
      "-v",
      `${path.join(root, "deploy/monitoring")}:/etc/prometheus:ro`,
      "-v",
      `${certs}:/run/secrets:ro`,
      "prom/prometheus:v3.5.0",
      ...args,
    );
  }
  passed("Prometheus configuration and alert firing tests pass");
  await dc("restart", "api", "worker");
  await dc("up", "-d", "--wait", "--wait-timeout", "120", "api", "worker", "web");
  const projects = await fetch(`${origin}/api/v1/projects`, { headers });
  assert.equal(projects.status, 200);
  assert((await projects.json()).some((item) => item.id === projectId));
  passed("container restart retains the account session and project data");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // This random project name is created by this script; no user deployment is selected.
  await dc("down", "--volumes", "--remove-orphans").catch(() => {});
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(
    path.join(root, "artifacts/deployment-test-report.json"),
    JSON.stringify(report, null, 2),
  );
}
