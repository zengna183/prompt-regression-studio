import { createDatabaseClient, createEvaluationRepository } from "@ai-chat-eval/db";
import { createEvaluationQueue } from "@ai-chat-eval/queue";
import { PythonProcessDiagnosisEngine } from "@prompt-regression/diagnosis-engine";

import { buildApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { createDatabaseCatalog } from "./database-catalog.js";
import { createDatabaseDiagnosisStore } from "./database-diagnosis-store.js";
import { createDatabaseEvaluationDispatcher } from "./evaluation-dispatcher.js";
import { createDatabaseExperimentService } from "./database-experiment-service.js";

const config = loadApiConfig();
const database = createDatabaseClient();
const evaluationQueue = createEvaluationQueue(config.REDIS_URL);
const diagnosisEngine = new PythonProcessDiagnosisEngine({
  executable: config.DIAGNOSIS_PYTHON_EXECUTABLE,
  moduleArgs: ["-m", "prompt_regression_core"],
  timeoutMs: config.DIAGNOSIS_TIMEOUT_MS,
  environment: {
    PYTHONUNBUFFERED: "1",
    ...(config.DIAGNOSIS_PYTHONPATH === undefined
      ? {}
      : { PYTHONPATH: config.DIAGNOSIS_PYTHONPATH }),
  },
});
const app = await buildApp({
  catalog: createDatabaseCatalog(database.db),
  diagnosisEngine,
  diagnosisStore: createDatabaseDiagnosisStore(database.db),
  evaluationDispatcher: createDatabaseEvaluationDispatcher(
    createEvaluationRepository(database.db),
    evaluationQueue,
  ),
  experimentService: createDatabaseExperimentService(database.db),
  ...(config.API_AUTH_TOKEN === undefined ? {} : { authToken: config.API_AUTH_TOKEN }),
  bodyLimitBytes: config.API_BODY_LIMIT_BYTES,
  docsEnabled: config.API_DOCS_ENABLED,
  productionMode: config.NODE_ENV === "production",
  rateLimitMax: config.API_RATE_LIMIT_MAX,
  rateLimitWindowMs: config.API_RATE_LIMIT_WINDOW_MS,
  diagnosisRateLimitMax: config.DIAGNOSIS_RATE_LIMIT_MAX,
  trustProxy: config.API_TRUST_PROXY,
  maxConcurrentDiagnoses: config.DIAGNOSIS_MAX_CONCURRENCY,
  readiness: async () => {
    await database.sql`select 1`;
  },
  webOrigin: config.WEB_ORIGIN,
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authorization",
        "request.headers.cookie",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.secret",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down API");
  try {
    await app.close();
    await evaluationQueue.close();
    await database.close();
  } catch (error) {
    app.log.error({ err: error }, "API shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API failed to start");
  await database.close();
  process.exitCode = 1;
}
