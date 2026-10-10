import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildApp } from "../apps/api/dist/app.js";
import { buildExperimentRegressionBundle } from "../apps/api/dist/experiment-diagnosis.js";
import { buildRecordedAblationBundle } from "../apps/api/dist/recorded-ablation.js";
import { revertPromptBlock } from "../packages/db/dist/index.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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
const ablationFixture = createRecordedFixture(experimentFixture, bundle);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRecordedBundle = ajv.compile(
  JSON.parse(
    await readFile(
      path.join(repositoryRoot, "contracts/regression-bundle/v1alpha1.schema.json"),
      "utf8",
    ),
  ),
);
const validateRecordedReport = ajv.compile(
  JSON.parse(
    await readFile(
      path.join(repositoryRoot, "contracts/diagnosis-report/v1alpha1.schema.json"),
      "utf8",
    ),
  ),
);
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
      const saved = input.includeAblations
        ? buildRecordedAblationBundle(experimentFixture.record, input, [ablationFixture])
        : buildExperimentRegressionBundle(experimentFixture.record, input);
      if (input.includeAblations && !validateRecordedBundle(saved))
        throw new Error(JSON.stringify(validateRecordedBundle.errors));
      return Promise.resolve(saved);
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
  const recordedResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/projects/${experimentFixture.record.project.id}/experiments/${experimentFixture.record.experiment.id}/diagnoses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidatePromptVersionId: experimentFixture.candidatePromptVersionId,
        includeAblations: true,
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );
  const recordedBody = await recordedResponse.text();
  if (!recordedResponse.ok)
    throw new Error(`recorded evidence smoke returned ${recordedResponse.status}: ${recordedBody}`);
  const recordedReport = JSON.parse(recordedBody);
  if (!validateRecordedReport(recordedReport))
    throw new Error(JSON.stringify(validateRecordedReport.errors));
  if (
    recordedReport.hypotheses.filter((item) => item.verification_status === "supported").length !==
      1 ||
    recordedReport.ablation_runs[0]?.runner !== "recorded-evaluation-runner" ||
    recordedReport.ablation_runs[0]?.eval_run.id !==
      ablationFixture.record.runs[1].evaluationRun.id ||
    recordedReport.ablation_runs[0]?.provenance.experiment_id !== ablationFixture.link.experimentId
  ) {
    throw new Error("recorded evidence smoke did not preserve real run provenance");
  }
  process.stdout.write(
    "recorded evidence smoke passed: supported=1, provenance preserved, schemas valid\n",
  );
} finally {
  await app.close();
}

function createRecordedFixture(source, canonical) {
  // Explicit offline test records, never selected by production configuration.
  const record = structuredClone(source.record);
  const segmentId = Object.keys(canonical.mock_ablation_results_by_segment)[0];
  const baseline = source.record.promptVersions.find((item) => item.isBaseline);
  const candidate = source.record.promptVersions.find((item) => !item.isBaseline);
  const experimentId = "00000000-0000-4000-8000-000000000021";
  const variantId = "00000000-0000-4000-8000-000000000022";
  const completedAt = new Date("2026-10-02T00:00:00.000Z");
  record.experiment.id = experimentId;
  record.promptVersions = structuredClone([
    { ...candidate, isBaseline: true },
    {
      ...candidate,
      isBaseline: false,
      version: {
        ...candidate.version,
        id: variantId,
        version: 3,
        blocks: revertPromptBlock(baseline.version.blocks, candidate.version.blocks, segmentId),
      },
    },
  ]);
  record.runs = [
    runPair("replay-generation", "replay-evaluation", candidate.version.id, completedAt),
    runPair("reverted-generation", "reverted-evaluation", variantId, completedAt),
  ];
  const outputs = (results, prefix, generationRunId) =>
    results.map((result, index) => ({
      id: `${prefix}-${index}`,
      generationRunId,
      caseId: result.test_case_id,
      status: "succeeded",
      outputText: result.output_text,
    }));
  const replayResults = canonical.candidate_eval_run.results;
  const variantResults = canonical.mock_ablation_results_by_segment[segmentId];
  const replayOutputs = outputs(replayResults, "replay-output", "replay-generation");
  const variantOutputs = outputs(variantResults, "variant-output", "reverted-generation");
  record.outputs = [...replayOutputs, ...variantOutputs];
  record.scores = [
    ...scoreRows(replayResults, replayOutputs, "replay-evaluation"),
    ...scoreRows(variantResults, variantOutputs, "reverted-evaluation"),
  ];
  return {
    record,
    link: {
      id: "00000000-0000-4000-8000-000000000020",
      sourceExperimentId: source.record.experiment.id,
      candidatePromptVersionId: candidate.version.id,
      revertedBlockId: segmentId,
      experimentId,
      variantPromptVersionId: variantId,
      createdAt: completedAt,
    },
  };
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
