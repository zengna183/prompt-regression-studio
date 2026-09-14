import { createDatabaseClient } from "@ai-chat-eval/db";
import { PythonProcessDiagnosisEngine } from "@prompt-regression/diagnosis-engine";

import { buildApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { createDatabaseCatalog } from "./database-catalog.js";
import { createDatabaseDiagnosisStore } from "./database-diagnosis-store.js";

const config = loadApiConfig();
const database = createDatabaseClient();
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
  maxConcurrentDiagnoses: config.DIAGNOSIS_MAX_CONCURRENCY,
  readiness: async () => {
    await database.sql`select 1`;
  },
  webOrigin: config.WEB_ORIGIN,
  logger: { level: config.LOG_LEVEL },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down API");
  try {
    await app.close();
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
