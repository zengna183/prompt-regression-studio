import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildApp } from "../apps/api/dist/app.js";
import { buildExperimentRegressionBundle } from "../apps/api/dist/experiment-diagnosis.js";
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
const experimentFixture = createExperimentFixture(bundle);
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
  experimentDiagnosisSource: {
    build(projectId, experimentId, input) {
      if (
        projectId !== experimentFixture.record.project.id ||
        experimentId !== experimentFixture.record.experiment.id
      ) {
        throw new Error("experiment smoke source received the wrong scope");
      }
      return Promise.resolve(buildExperimentRegressionBundle(experimentFixture.record, input));
    },
  },
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

  const experimentResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/projects/${experimentFixture.record.project.id}/experiments/${experimentFixture.record.experiment.id}/diagnoses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidatePromptVersionId: experimentFixture.candidatePromptVersionId,
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );
  const experimentBody = await experimentResponse.text();
  if (!experimentResponse.ok) {
    throw new Error(
      `experiment diagnosis smoke test returned ${experimentResponse.status}: ${experimentBody}`,
    );
  }
  const experimentReport = JSON.parse(experimentBody);
  const verified = experimentReport.hypotheses?.filter(
    (item) => item.verification_status === "supported",
  );
  if (
    experimentReport.schema_version !== "prompt-regression.report/v1alpha1" ||
    experimentReport.regression?.cases?.length !== 2 ||
    experimentReport.prompt_changes?.length !== 1 ||
    experimentReport.failure_clusters?.length !== 1 ||
    experimentReport.hypotheses?.length < 1 ||
    verified?.length !== 0
  ) {
    throw new Error("experiment diagnosis smoke test returned an unexpected report");
  }
  process.stdout.write(
    `experiment smoke passed: regressions=${experimentReport.regression.cases.length}, changes=${experimentReport.prompt_changes.length}, verified=${verified.length}\n`,
  );
} finally {
  await app.close();
}

function createExperimentFixture(canonical) {
  const ids = {
    project: "00000000-0000-4000-8000-000000000001",
    experiment: "00000000-0000-4000-8000-000000000002",
    dataset: "00000000-0000-4000-8000-000000000003",
    datasetVersion: "00000000-0000-4000-8000-000000000004",
    frameworkVersion: "00000000-0000-4000-8000-000000000005",
    prompt: "00000000-0000-4000-8000-000000000006",
    baselinePromptVersion: "00000000-0000-4000-8000-000000000007",
    candidatePromptVersion: "00000000-0000-4000-8000-000000000008",
    baselineGeneration: "00000000-0000-4000-8000-000000000009",
    candidateGeneration: "00000000-0000-4000-8000-000000000010",
    baselineEvaluation: "00000000-0000-4000-8000-000000000011",
    candidateEvaluation: "00000000-0000-4000-8000-000000000012",
  };
  const completedAt = new Date("2026-09-13T00:00:00.000Z");
  const baselineOutputs = canonical.baseline_eval_run.results.map((result, index) => ({
    id: `baseline-output-${String(index + 1)}`,
    generationRunId: ids.baselineGeneration,
    caseId: result.test_case_id,
    status: "succeeded",
    outputText: result.output_text,
  }));
  const candidateOutputs = canonical.candidate_eval_run.results.map((result, index) => ({
    id: `candidate-output-${String(index + 1)}`,
    generationRunId: ids.candidateGeneration,
    caseId: result.test_case_id,
    status: "succeeded",
    outputText: result.output_text,
  }));

  return {
    candidatePromptVersionId: ids.candidatePromptVersion,
    record: {
      project: { id: ids.project, name: canonical.project.name },
      experiment: { id: ids.experiment, projectId: ids.project, randomSeed: 42 },
      dataset: { id: ids.dataset, name: canonical.dataset.name },
      datasetVersion: {
        id: ids.datasetVersion,
        version: 1,
        caseCount: canonical.dataset.test_cases.length,
      },
      frameworkVersion: { id: ids.frameworkVersion, contentHash: "f".repeat(64) },
      promptVersions: [
        promptSelection(
          canonical,
          canonical.baseline_prompt_version,
          ids.prompt,
          ids.baselinePromptVersion,
          true,
        ),
        promptSelection(
          canonical,
          canonical.candidate_prompt_version,
          ids.prompt,
          ids.candidatePromptVersion,
          false,
        ),
      ],
      cases: canonical.dataset.test_cases.map((item, index) => ({
        id: item.id,
        input: item.input,
        expectedOutput: item.expected ?? null,
        metadata: item.metadata ?? {},
        sortOrder: index,
      })),
      runs: [
        runPair(
          ids.baselineGeneration,
          ids.baselineEvaluation,
          ids.baselinePromptVersion,
          completedAt,
        ),
        runPair(
          ids.candidateGeneration,
          ids.candidateEvaluation,
          ids.candidatePromptVersion,
          completedAt,
        ),
      ],
      outputs: [...baselineOutputs, ...candidateOutputs],
      scores: [
        ...scoreRows(canonical.baseline_eval_run.results, baselineOutputs, ids.baselineEvaluation),
        ...scoreRows(
          canonical.candidate_eval_run.results,
          candidateOutputs,
          ids.candidateEvaluation,
        ),
      ],
    },
  };
}

function promptSelection(canonical, version, promptId, versionId, isBaseline) {
  return {
    isBaseline,
    label: isBaseline ? "baseline" : "candidate",
    prompt: { id: promptId, projectId: canonical.project.id, name: canonical.prompt.name },
    version: {
      id: versionId,
      promptId,
      version: version.version,
      blocks: version.segments.map((segment) => ({
        id: segment.id,
        kind:
          segment.kind === "policy" || segment.kind === "role"
            ? segment.kind
            : segment.kind === "system_role"
              ? "role"
              : "custom",
        name: segment.semantic_tags?.[0] ?? segment.id,
        content: segment.content,
      })),
    },
  };
}

function runPair(generationRunId, evaluationRunId, promptVersionId, completedAt) {
  return {
    generationRun: {
      id: generationRunId,
      promptVersionId,
      status: "succeeded",
      provider: "fixture",
      model: "recorded-example",
      modelConfig: { temperature: 0 },
      modelConfigHash: "a".repeat(64),
      repetition: 1,
      completedAt,
    },
    evaluationRun: {
      id: evaluationRunId,
      status: "succeeded",
      evaluatorKey: "recorded-groundedness",
      evaluatorVersion: "1",
      evaluatorConfig: { mode: "fixture" },
      evaluatorConfigHash: "b".repeat(64),
      completedAt,
    },
  };
}

function scoreRows(results, outputs, evaluationRunId) {
  return results.flatMap((result, index) => {
    const output = outputs[index];
    const primary = result.metrics[0];
    return [
      {
        evaluationRunId,
        generationOutputId: output.id,
        kind: "overall",
        metricKey: "__overall__",
        normalizedScore: primary.score,
        passed: result.passed,
        rationale: primary.reason ?? null,
      },
      ...result.metrics.map((metric) => ({
        evaluationRunId,
        generationOutputId: output.id,
        kind: "dimension",
        metricKey: metric.metric_key,
        normalizedScore: metric.score,
        passed: metric.passed ?? result.passed,
        rationale: metric.reason ?? null,
      })),
    ];
  });
}
