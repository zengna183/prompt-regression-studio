import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// Never fall back to DATABASE_URL / REDIS_URL or load the developer's .env.
export function testTargets(env) {
  const parse = (key, protocols) => {
    let url;
    try {
      url = new URL(env[key]);
    } catch {
      throw new Error(`${key} must explicitly point to disposable local test infrastructure`);
    }
    assert(protocols.includes(url.protocol), `${key}: unsupported protocol`);
    assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), `${key}: loopback only`);
    assert(!url.search && !url.hash, `${key}: URL options are not allowed`);
    return url;
  };
  const database = parse("TEST_SYSTEM_DATABASE_URL", ["postgres:", "postgresql:"]);
  const redis = parse("TEST_SYSTEM_REDIS_URL", ["redis:"]);
  assert(
    /^\/prs_system_test(?:_[a-z0-9]+)?$/u.test(database.pathname),
    "Disposable database name must start with prs_system_test",
  );
  assert.equal(redis.pathname, "/15", "Use dedicated, empty Redis database 15");
  return { databaseUrl: database.href, redisUrl: redis.href };
}

export async function eventually(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

export async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function managedProcess(name, args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let finished = false;
  let spawnError;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output = (output + data.toString()).slice(-12_000);
    });
  }
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      finished = true;
      resolve({ code, signal });
    }),
  );
  return {
    child,
    assertAlive() {
      if (spawnError || finished)
        throw new Error(`${name} exited unexpectedly: ${spawnError?.message ?? output}`);
    },
    async complete(timeoutMs = 30_000) {
      const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      try {
        const result = await closed;
        assert.equal(result.code, 0, `${name} failed: ${output}`);
      } finally {
        clearTimeout(timeout);
      }
    },
    async stop(force = false) {
      if (finished) return;
      child.kill(force ? "SIGKILL" : "SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export async function loadSample(request, count = 200, concurrency = 10) {
  const latencies = [];
  const errors = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < count) {
        const start = performance.now();
        try {
          await request();
        } catch (error) {
          errors.push(error.message);
        }
        latencies.push(performance.now() - start);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const percentile = (p) => Math.round(latencies[Math.ceil(latencies.length * p) - 1]);
  return {
    requests: count,
    concurrency,
    errors: errors.length,
    firstError: errors[0],
    elapsedMs: Math.round(performance.now() - started),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
  };
}
