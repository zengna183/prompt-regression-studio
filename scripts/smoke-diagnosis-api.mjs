import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildApp } from "../apps/api/dist/app.js";
import { PythonProcessDiagnosisEngine } from "../packages/diagnosis-engine/dist/index.js";
import { resolvePythonExecutable } from "./python-executable.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSource = path.join(repositoryRoot, "packages", "python", "core", "src");
const fixturePath = path.join(
  repositoryRoot,
  "examples",
  "missing-information-regression",
  "regression-bundle.json",
);
const executable = resolvePythonExecutable(
  repositoryRoot,
  process.env.PROMPT_REGRESSION_TEST_PYTHON,
);
const bundle = JSON.parse(await readFile(fixturePath, "utf8"));
const engine = new PythonProcessDiagnosisEngine({
  executable,
  cwd: repositoryRoot,
  timeoutMs: 30_000,
  environment: {
    PYTHONIOENCODING: "utf-8",
    PYTHONPATH: coreSource,
    PYTHONUNBUFFERED: "1",
  },
});

// The smoke test never calls catalog routes, so a no-op object is sufficient at
// runtime. Unit tests cover the catalog contract independently.
const app = await buildApp({
  catalog: {},
  diagnosisEngine: engine,
  maxConcurrentDiagnoses: 1,
});

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("diagnosis API smoke test could not determine the HTTP listener address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/diagnoses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle),
    signal: AbortSignal.timeout(45_000),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`diagnosis API smoke test returned ${response.status}: ${responseBody}`);
  }

  let report;
  try {
    report = JSON.parse(responseBody);
  } catch (error) {
    throw new Error("diagnosis API smoke test returned invalid JSON", { cause: error });
  }
  const supported = report.hypotheses?.filter((item) => item.verification_status === "supported");
  if (
    report.schema_version !== "prompt-regression.report/v1alpha1" ||
    report.regression?.cases?.length !== 2 ||
    supported?.length !== 1
  ) {
    throw new Error("diagnosis API smoke test returned an unexpected report");
  }
  process.stdout.write(
    `smoke passed: regressions=${report.regression.cases.length}, supported=${supported.length}\n`,
  );
} finally {
  await app.close();
}
