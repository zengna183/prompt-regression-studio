import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePythonExecutable } from "./python-executable.mjs";
import { fixtureProvider } from "./system-test-provider.mjs";
import {
  eventually,
  freePort,
  loadSample,
  managedProcess,
  networkGate,
  testTargets,
} from "./system-test-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "Isolated real HTTP/API/Worker/Python/PostgreSQL/Redis with a deterministic local provider; not browser E2E or production capacity certification",
  checks: [],
};
const processes = [];
let database, redis, queue, provider, redisGate;
let api, worker;
let token;
const check = async (name, run) => {
  const start = performance.now();
  await run();
  report.checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
};

try {
  // Validate before importing dependencies, migrating, starting services, or writing data.
  const targets = testTargets(process.env);
  const { createDatabaseClient, createIdentityRepository } =
    await import("../packages/db/dist/index.js");
  const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
  const queueRequire = createRequire(new URL("../packages/queue/package.json", import.meta.url));
  const { Redis } = queueRequire("ioredis");
  const { Queue } = require("bullmq");
  redis = new Redis(targets.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 5000,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  assert.equal(
    await redis.dbsize(),
    0,
    "Refusing nonempty Redis test database; use fresh infrastructure",
  );
  database = createDatabaseClient({
    url: targets.databaseUrl,
    poolMax: 5,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 3,
    ssl: false,
  });
  // A previously populated schema is not disposable merely because its name looks like one.
  const tables =
    await database.sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`;
  assert.equal(tables.length, 0, "Refusing an existing test schema; provision a fresh database");
  redisGate = await networkGate(new URL(targets.redisUrl));
  const apiRedisUrl = new URL(targets.redisUrl);
  apiRedisUrl.hostname = "127.0.0.1";
  apiRedisUrl.port = String(redisGate.port);
  const apiPort = await freePort();
  const workerPort = await freePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const providerKey = randomBytes(24).toString("hex");
  provider = await fixtureProvider(providerKey);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: targets.databaseUrl,
    DATABASE_SSL: "false",
    REDIS_URL: targets.redisUrl,
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    WEB_ORIGIN: "http://localhost:5173",
    AUTH_MODE: "team",
    API_AUTH_TOKEN: "",
    API_RATE_LIMIT_MAX: "10000",
    DIAGNOSIS_RATE_LIMIT_MAX: "100",
    LOG_LEVEL: "error",
    DATASET_GENERATION_MODEL: "",
    MODEL_PROVIDER_API_KEY: "",
    MODEL_PROVIDER_BASE_URL: provider.baseUrl,
    MODEL_PROVIDER_ALLOW_PRIVATE_NETWORK: "true",
    MODEL_PROVIDER_ALLOWED_HOSTS: "",
    MODEL_PROVIDER_TIMEOUT_MS: "1000",
    MODEL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    WORKER_HEALTH_HOST: "127.0.0.1",
    WORKER_HEALTH_PORT: String(workerPort),
    WORKER_CONCURRENCY: "2",
    DIAGNOSIS_PYTHON_EXECUTABLE: resolvePythonExecutable(
      root,
      process.env.PROMPT_REGRESSION_TEST_PYTHON,
    ),
    DIAGNOSIS_PYTHONPATH: path.join(root, "packages/python/core/src"),
  };
  const spawn = (name, entry) => {
    const proc = managedProcess(name, [entry], {
      cwd: root,
      env: name === "API" ? { ...env, REDIS_URL: apiRedisUrl.href } : env,
    });
    processes.push(proc);
    return proc;
  };
  const ready = (proc, url) =>
    eventually(
      async () => {
        proc.assertAlive();
        try {
          return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      `service ready ${url}`,
      30_000,
    );
  const startApi = async () => {
    api = spawn("API", "apps/api/dist/server.js");
    await ready(api, `${base}/health/ready`);
  };
  const startWorker = async () => {
    worker = spawn("Worker", "apps/worker/dist/index.js");
    await ready(worker, `http://127.0.0.1:${workerPort}/health/ready`);
  };
  const http = async (method, route, body, status = 200) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
  await check("fresh database migration and authenticated real API", async () => {
    await spawn("migration", "packages/db/dist/migrate.js").complete();
    const password = randomBytes(24).toString("base64url");
    await createIdentityRepository(database.db).bootstrap({
      email: "system-test@example.invalid",
      password,
      displayName: "System Test",
    });
    await startApi();
    await http("GET", "/v1/projects", undefined, 401);
    token = (
      await http("POST", "/v1/auth/login", { email: "system-test@example.invalid", password })
    ).token;
  });
  queue = new Queue("evaluation-runs", { connection: redis });
  const project = await http(
    "POST",
    "/v1/projects",
    { slug: "system-test", name: "System Test" },
    201,
  );
  const projectPath = `/v1/projects/${project.id}`;
  const expPath = (id) => `${projectPath}/experiments/${id}`;
  let baseline, candidate, framework, dataset, faultDataset, connection, happy;
  const cases = Array.from({ length: 8 }, (_, i) => ({
    caseKey: `case-${i}`,
    input: `${i < 3 ? "target" : "control"}-${i}`,
    expectedOutput: "good",
    metadata: { domain: i < 3 ? "target" : "control" },
  }));
  await check(
    "publish prompts, rubric, reviewed cases and encrypted model connection through HTTP",
    async () => {
      const prompt = await http(
        "POST",
        `${projectPath}/prompts`,
        { key: "support-prompt", name: "Support prompt" },
        201,
      );
      const version = async (policy, parent) => {
        const draft = await http(
          "POST",
          `/v1/prompts/${prompt.id}/versions`,
          {
            ...(parent ? { parentVersionId: parent.id } : {}),
            blocks: [
              { id: "role", kind: "role", name: "Role", content: "Answer the user" },
              { id: "policy", kind: "policy", name: "Policy", content: policy },
            ],
          },
          201,
        );
        return http("POST", `/v1/prompt-versions/${draft.id}/publish`);
      };
      baseline = await version("GOOD_POLICY");
      candidate = await version("BAD_POLICY", baseline);
      const rubric = await http(
        "POST",
        `${projectPath}/frameworks`,
        { key: "system-rubric", name: "System rubric" },
        201,
      );
      const draft = await http(
        "POST",
        `/v1/frameworks/${rubric.id}/versions`,
        {
          definition: {
            levels: [{ id: "quality", name: "Quality", description: "Fixture evaluation" }],
            dimensions: [
              {
                id: "quality",
                name: "Quality",
                description: "Matches expected answer",
                weight: 1,
                scoringGuide: [
                  { score: 0, description: "bad" },
                  { score: 1, description: "good" },
                ],
              },
            ],
          },
        },
        201,
      );
      framework = await http("POST", `/v1/framework-versions/${draft.id}/publish`);
      const publishDataset = async (key, inputs) => {
        const parent = await http("POST", `${projectPath}/datasets`, { key, name: key }, 201);
        const draft = await http(
          "POST",
          `/v1/datasets/${parent.id}/versions`,
          { cases: inputs },
          201,
        );
        await http("POST", `/v1/dataset-versions/${draft.id}/publish`, undefined, 409);
        const reviewed = await http("POST", `/v1/dataset-versions/${draft.id}/review`, {
          cases: inputs,
          reviewerName: "System Test",
          acknowledged: true,
        });
        return http("POST", `/v1/dataset-versions/${reviewed.id}/publish`);
      };
      dataset = await publishDataset("full-workflow", cases);
      faultDataset = await publishDataset("fault-workflow", [cases[3]]);
      connection = await http(
        "POST",
        `${projectPath}/model-connections`,
        {
          name: "Local deterministic test provider",
          baseUrl: provider.baseUrl,
          apiKey: providerKey,
          supportsSeed: true,
          allowedModels: [
            "system-generator",
            "system-judge",
            "fault-rate",
            "fault-timeout",
            "fault-judge",
            "restart-generator",
          ],
        },
        201,
      );
      assert(
        !JSON.stringify(connection).includes(providerKey),
        "Credential leaked in HTTP response",
      );
      const [stored] =
        await database.sql`select api_key_ciphertext from model_connections where id=${connection.id}`;
      assert(!JSON.stringify(stored).includes(providerKey), "Credential stored without encryption");
    },
  );
  const plan = (name, ds = dataset, repetitions = 1) =>
    http(
      "POST",
      `${projectPath}/experiments`,
      {
        name,
        datasetVersionId: ds.id,
        frameworkVersionId: framework.id,
        randomSeed: 42,
        repetitions,
        promptVersions: [
          { promptVersionId: baseline.id, label: "baseline", isBaseline: true },
          { promptVersionId: candidate.id, label: "candidate", isBaseline: false },
        ],
      },
      201,
    );
  const start = (id, model = "system-generator", evaluatorModel = "system-judge") =>
    http(
      "POST",
      `${expPath(id)}/start`,
      {
        provider: "openai-compatible",
        model,
        evaluatorModel,
        modelConnectionId: connection.id,
        evaluatorConnectionId: connection.id,
        modelConfig: { temperature: 0, maxTokens: 128 },
      },
      202,
    );
  const settled = (id) =>
    eventually(
      async () => {
        api.assertAlive();
        worker.assertAlive();
        const detail = await http("GET", expPath(id));
        return !["draft", "queued", "running"].includes(detail.experiment.status) && detail;
      },
      `experiment ${id} settles`,
      90_000,
    );
  const assertSuccess = async (id, count) => {
    const detail = await settled(id);
    assert.equal(detail.experiment.status, "succeeded", JSON.stringify(detail));
    assert.equal(detail.progress.completedCaseExecutions, count);
    assert(detail.runs.every((r) => r.failedCount === 0));
    const comparison = await http("GET", `${expPath(id)}/comparison`);
    assert.equal(comparison.isComplete, true);
    assert(comparison.versions.every((v) => v.coverageRate === 1));
    return comparison;
  };
  await check(
    "API and worker restart preserve queued jobs and concurrent starts remain idempotent",
    async () => {
      happy = await plan("Happy workflow");
      const starts = await Promise.all([start(happy.id), start(happy.id)]);
      assert.deepEqual(
        [...starts[0].evaluationRunIds].sort(),
        [...starts[1].evaluationRunIds].sort(),
      );
      assert.equal(starts[0].evaluationRunIds.length, 2);
      const apiExit = await api.stop();
      if (process.platform !== "win32")
        assert.equal(
          apiExit.code,
          0,
          "API required forced termination instead of graceful shutdown",
        );
      await startApi(); // Same server-side session and persisted outbox survive the process restart.
      await startWorker();
      const workerExit = await worker.stop();
      if (process.platform !== "win32")
        assert.equal(workerExit.code, 0, "Worker failed graceful shutdown");
      await startWorker();
      const comparison = await assertSuccess(happy.id, 16);
      assert.equal(comparison.versions.find((v) => v.isBaseline).averageScore, 1);
      assert.equal(comparison.versions.find((v) => !v.isBaseline).averageScore, 0.625);
      const [runs] =
        await database.sql`select count(*)::int as count from evaluation_runs where experiment_id=${happy.id}`;
      assert.equal(runs.count, 2);
    },
  );
  const diagnose = (includeAblations = false) =>
    http("POST", `${expPath(happy.id)}/diagnoses`, {
      candidatePromptVersionId: candidate.id,
      includeAblations,
    });
  await check(
    "real Python diagnosis, recorded single-block revert, replay evidence and saved history",
    async () => {
      const reportBefore = await diagnose();
      assert.equal(reportBefore.schema_version, "prompt-regression.report/v1alpha1");
      assert.equal(reportBefore.regression.cases.length, 3);
      assert(reportBefore.hypotheses.every((h) => h.verification_status !== "supported"));
      const ablation = await http(
        "POST",
        `${expPath(happy.id)}/ablations`,
        { candidatePromptVersionId: candidate.id, blockId: "policy" },
        202,
      );
      await assertSuccess(ablation.experimentId, 16);
      const verified = await diagnose(true);
      assert(
        verified.hypotheses.some((h) => h.verification_status === "supported"),
        "Recorded revert did not support the changed policy hypothesis",
      );
      const history = await http("GET", `/v1/diagnoses?projectId=${project.id}`);
      assert(history.items.length >= 2);
      const saved = await http("GET", `/v1/diagnoses/${history.items[0].id}`);
      assert.equal(saved.status, "succeeded");
      assert.equal(saved.report.report_id, verified.report_id);
    },
  );
  await check("provider 429 retries recover without duplicate stored outputs", async () => {
    const experiment = await plan("Rate-limit recovery", faultDataset);
    await start(experiment.id, "fault-rate");
    await assertSuccess(experiment.id, 2);
    assert(provider.count("fault-rate") >= 4);
    const [outputs] =
      await database.sql`select count(*)::int as count from generation_outputs o join generation_runs r on r.id=o.generation_run_id where r.experiment_id=${experiment.id}`;
    assert.equal(outputs.count, 2);
  });
  for (const [name, model, judge] of [
    ["provider timeout", "fault-timeout", "system-judge"],
    ["malformed judge", "system-generator", "fault-judge"],
  ]) {
    await check(`${name} records failures and never fabricates complete scores`, async () => {
      const experiment = await plan(name, faultDataset);
      await start(experiment.id, model, judge);
      const detail = await settled(experiment.id);
      assert.notEqual(detail.experiment.status, "succeeded");
      assert(detail.runs.every((r) => r.failedCount === 1 && r.succeededCount === 0));
      const outputs =
        await database.sql`select o.error_code from generation_outputs o join generation_runs r on r.id=o.generation_run_id where r.experiment_id=${experiment.id}`;
      assert.equal(outputs.length, 2);
      assert(
        outputs.every(
          (o) =>
            o.error_code ===
            (name === "provider timeout" ? "PROVIDER_TIMEOUT" : "EVALUATION_CASE_FAILED"),
        ),
      );
      const comparison = await http("GET", `${expPath(experiment.id)}/comparison`);
      assert.equal(comparison.isComplete, false);
      assert(comparison.versions.every((v) => v.observationCount === 0));
    });
  }
  await check("cancel during an outstanding model request remains terminal", async () => {
    const experiment = await plan("Cancellation", faultDataset);
    const before = provider.count("fault-timeout");
    await start(experiment.id, "fault-timeout");
    await eventually(() => provider.count("fault-timeout") > before, "model request in flight");
    await http("POST", `${expPath(experiment.id)}/cancel`);
    assert.equal((await settled(experiment.id)).experiment.status, "cancelled");
    await delay(4000);
    const detail = await http("GET", expPath(experiment.id));
    assert.equal(detail.experiment.status, "cancelled");
    assert(detail.runs.every((r) => r.status === "cancelled"));
    const [outputs] =
      await database.sql`select count(*)::int as count from generation_outputs o join generation_runs r on r.id=o.generation_run_id where r.experiment_id=${experiment.id}`;
    assert.equal(outputs.count, 0, "Cancellation was overwritten by a late provider response");
  });
  await check(
    "worker crash redelivery waits for database lease and resumes after controlled expiry",
    async () => {
      const experiment = await plan("Lease recovery", faultDataset);
      provider.holdRestart(true);
      const started = await start(experiment.id, "restart-generator");
      await eventually(
        () => provider.count("restart-generator") >= 2,
        "both workers executing model calls",
      );
      await worker.stop(true); // Actual abrupt child-process death, not graceful completion.
      await startWorker();
      await eventually(
        async () => {
          const jobs = await Promise.all(
            started.evaluationRunIds.map((id) => queue.getJob(`evaluation-${id}`)),
          );
          return (
            jobs.every(Boolean) &&
            (await Promise.all(jobs.map((j) => j.getState()))).every((state) => state === "delayed")
          );
        },
        "stalled jobs redelivered and busy leases delayed instead of acknowledged",
        90_000,
      );
      for (const id of started.evaluationRunIds) {
        const job = await queue.getJob(`evaluation-${id}`);
        assert.equal(job.attemptsMade, 0, "Waiting for a lease consumed an error retry");
      }
      // Accelerate only the isolated DB fixture, after proving the fresh lease was respected.
      // Production recovery still waits for the current 30-minute DB lease expiry.
      await database.sql`update evaluation_runs set started_at=now()-interval '31 minutes' where experiment_id=${experiment.id}`;
      provider.holdRestart(false);
      for (const id of started.evaluationRunIds)
        await (await queue.getJob(`evaluation-${id}`)).promote();
      await assertSuccess(experiment.id, 2);
    },
  );
  await check(
    "Redis network outage persists outbox and recovers dispatch after reconnection",
    async () => {
      redisGate.setEnabled(false);
      const experiment = await plan("Queue outage", faultDataset);
      await start(experiment.id);
      await eventually(
        async () => {
          const [row] =
            await database.sql`select count(*)::int as count from evaluation_run_dispatches d join evaluation_runs r on r.id=d.evaluation_run_id where r.experiment_id=${experiment.id} and d.last_error_code='QUEUE_DISPATCH_FAILED'`;
          return row.count === 2;
        },
        "durable outbox records broker failure",
        30_000,
      );
      assert.equal((await http("GET", expPath(experiment.id))).experiment.status, "queued");
      redisGate.setEnabled(true);
      await assertSuccess(experiment.id, 2);
    },
  );
  await check(
    "bounded concurrent reads while repeated evaluations run retain exact coverage",
    async () => {
      const experiment = await plan("Bounded load", dataset, 3);
      await start(experiment.id);
      report.load = await loadSample(() => http("GET", `${expPath(happy.id)}/comparison`));
      assert.equal(report.load.errors, 0, JSON.stringify(report.load));
      assert(report.load.maxMs < 30_000, "HTTP exceeded the test watchdog, not a production SLA");
      const comparison = await assertSuccess(experiment.id, 48);
      assert.equal(comparison.expectedObservationsPerVersion, 24);
      const [outputs] =
        await database.sql`select count(*)::int as count from generation_outputs o join generation_runs r on r.id=o.generation_run_id where r.experiment_id=${experiment.id}`;
      assert.equal(outputs.count, 48);
    },
  );
  report.provider = provider.stats();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  console.error(error);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(
      `::error title=System acceptance::${error.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  }
  process.exitCode = 1;
} finally {
  // Always close children before databases, including after assertion failures.
  for (const proc of [...processes].reverse()) await proc.stop().catch(() => {});
  await queue?.close().catch(() => {});
  redis?.disconnect();
  await database?.close().catch(() => {});
  await redisGate?.close().catch(() => {});
  await provider?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(
    path.join(root, "artifacts/system-test-report.json"),
    JSON.stringify(report, null, 2),
  );
}
