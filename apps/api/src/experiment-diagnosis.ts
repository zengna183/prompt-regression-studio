import type {
  CreateExperimentDiagnosis,
  ExperimentDiagnosisDetection,
} from "@ai-chat-eval/contracts";
import {
  stableStringify,
  type ExperimentDiagnosisPromptVersion,
  type ExperimentDiagnosisRecord,
  type ExperimentDiagnosisRun,
  type JsonValue as DatabaseJsonValue,
} from "@ai-chat-eval/db";
import type { JsonObject } from "@prompt-regression/diagnosis-engine";

export interface ExperimentDiagnosisSource {
  build(
    projectId: string,
    experimentId: string,
    input: CreateExperimentDiagnosis,
  ): Promise<JsonObject>;
}

export type ExperimentDiagnosisBuildErrorCode =
  "DIAGNOSIS_SELECTION_INVALID" | "DIAGNOSIS_INPUT_INCOMPLETE" | "DIAGNOSIS_COMPARISON_CONFOUNDED";

export class ExperimentDiagnosisBuildError extends Error {
  override readonly name = "ExperimentDiagnosisBuildError";

  constructor(
    readonly statusCode: 409 | 422,
    readonly code: ExperimentDiagnosisBuildErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface MetricPayload extends JsonObject {
  readonly metric_key: string;
  readonly score: number;
  readonly passed: boolean;
  readonly reason?: string;
}

interface ResultPayload extends JsonObject {
  readonly id: string;
  readonly test_case_id: string;
  readonly output_text: string;
  readonly passed: boolean;
  readonly metrics: readonly MetricPayload[];
  readonly metadata: JsonObject;
}

const defaultDetection = Object.freeze({
  primaryMetric: "__overall__",
  metricDropThreshold: 0.1,
  minTargetCases: 1,
  minControlCases: 1,
  supportRecoveryRatio: 0.6,
  rejectRecoveryRatio: 0.1,
  maxControlDamage: 0.05,
});

/** Convert a completed experiment pair into the language-neutral Core contract. */
export function buildExperimentRegressionBundle(
  record: ExperimentDiagnosisRecord,
  input: CreateExperimentDiagnosis,
): JsonObject {
  const repetition = input.repetition ?? 1;
  if (!Number.isSafeInteger(repetition) || repetition < 1 || repetition > 100) {
    throw invalidSelection("repetition must be an integer from 1 to 100");
  }

  const baselineSelections = record.promptVersions.filter((item) => item.isBaseline);
  if (baselineSelections.length !== 1) {
    throw incomplete("The experiment must contain exactly one baseline Prompt version.");
  }
  const baselineSelection = baselineSelections[0];
  if (!baselineSelection) throw incomplete("The experiment baseline is missing.");
  const candidateSelection = record.promptVersions.find(
    (item) => item.version.id === input.candidatePromptVersionId,
  );
  if (!candidateSelection || candidateSelection.isBaseline) {
    throw invalidSelection(
      "candidatePromptVersionId must select a non-baseline version from this experiment.",
    );
  }
  if (
    baselineSelection.prompt.id !== candidateSelection.prompt.id ||
    baselineSelection.version.promptId !== candidateSelection.version.promptId
  ) {
    throw invalidSelection(
      "Baseline and candidate must be versions of the same Prompt for segment attribution.",
    );
  }

  const baselineRun = requireRun(record, baselineSelection.version.id, repetition);
  const candidateRun = requireRun(record, candidateSelection.version.id, repetition);
  const baselineModelSnapshot = modelSnapshot(record, baselineRun);
  const candidateModelSnapshot = modelSnapshot(record, candidateRun);
  const baselineEvaluatorSnapshot = evaluatorSnapshot(record, baselineRun);
  const candidateEvaluatorSnapshot = evaluatorSnapshot(record, candidateRun);
  if (stableStringify(baselineModelSnapshot) !== stableStringify(candidateModelSnapshot)) {
    throw confounded("Baseline and candidate used different model settings.");
  }
  if (stableStringify(baselineEvaluatorSnapshot) !== stableStringify(candidateEvaluatorSnapshot)) {
    throw confounded("Baseline and candidate used different evaluator settings.");
  }

  const detection = normalizeDetection(input.detection);
  const cases = requireCases(record);
  const baselineResults = buildResults(record, baselineRun, cases, detection.primaryMetric);
  const candidateResults = addFailureModes(
    buildResults(record, candidateRun, cases, detection.primaryMetric),
    baselineResults,
    detection.primaryMetric,
  );
  const completedAt = latestCompletion(baselineRun, candidateRun);

  return {
    schema_version: "prompt-regression.bundle/v1alpha1",
    bundle_id: `experiment-${record.experiment.id}-candidate-${candidateSelection.version.id}-r${String(repetition)}`,
    // A stable terminal timestamp keeps identical experiment diagnoses byte reproducible.
    diagnosis_requested_at: completedAt.toISOString(),
    project: {
      id: record.project.id,
      name: record.project.name,
    },
    prompt: {
      id: baselineSelection.prompt.id,
      project_id: record.project.id,
      name: baselineSelection.prompt.name,
    },
    dataset: {
      id: record.datasetVersion.id,
      project_id: record.project.id,
      name: `${record.dataset.name} v${String(record.datasetVersion.version)}`,
      test_cases: cases.map((item) => ({
        id: item.id,
        input: asObject(item.input),
        ...(item.expectedOutput === null ? {} : { expected: asObject(item.expectedOutput) }),
        metadata: {
          ...asObject(item.metadata),
          original_case_id: item.id,
          repetition,
        },
      })),
    },
    baseline_prompt_version: promptVersionPayload(baselineSelection),
    candidate_prompt_version: promptVersionPayload(candidateSelection),
    baseline_eval_run: {
      id: baselineRun.evaluationRun.id,
      prompt_version_id: baselineSelection.version.id,
      dataset_id: record.datasetVersion.id,
      results: baselineResults,
      model_snapshot: baselineModelSnapshot,
      evaluator_snapshot: baselineEvaluatorSnapshot,
    },
    candidate_eval_run: {
      id: candidateRun.evaluationRun.id,
      prompt_version_id: candidateSelection.version.id,
      dataset_id: record.datasetVersion.id,
      results: candidateResults,
      model_snapshot: candidateModelSnapshot,
      evaluator_snapshot: candidateEvaluatorSnapshot,
    },
    detection: {
      primary_metric: detection.primaryMetric,
      metric_drop_threshold: detection.metricDropThreshold,
      min_target_cases: detection.minTargetCases,
      min_control_cases: detection.minControlCases,
      support_recovery_ratio: detection.supportRecoveryRatio,
      reject_recovery_ratio: detection.rejectRecoveryRatio,
      max_control_damage: detection.maxControlDamage,
    },
    // Real ablation evidence is added only after the controlled worker run exists.
    mock_ablation_results_by_segment: {},
  };
}

function requireRun(
  record: ExperimentDiagnosisRecord,
  promptVersionId: string,
  repetition: number,
): ExperimentDiagnosisRun {
  const matches = record.runs.filter(
    (item) =>
      item.generationRun.promptVersionId === promptVersionId &&
      item.generationRun.repetition === repetition,
  );
  if (matches.length !== 1) {
    throw incomplete(
      `Exactly one evaluation run is required for Prompt version ${promptVersionId} repetition ${String(repetition)}.`,
    );
  }
  const run = matches[0];
  if (!run) throw incomplete("The selected evaluation run is missing.");
  if (
    run.generationRun.status !== "succeeded" ||
    run.evaluationRun.status !== "succeeded" ||
    run.generationRun.completedAt === null ||
    run.evaluationRun.completedAt === null
  ) {
    throw incomplete("Both selected runs must finish successfully before diagnosis.");
  }
  return run;
}

function requireCases(record: ExperimentDiagnosisRecord): ExperimentDiagnosisRecord["cases"] {
  if (
    record.cases.length < 1 ||
    record.cases.length !== record.datasetVersion.caseCount ||
    new Set(record.cases.map((item) => item.id)).size !== record.cases.length
  ) {
    throw incomplete("The saved dataset is empty, duplicated, or incomplete.");
  }
  return record.cases;
}

function buildResults(
  record: ExperimentDiagnosisRecord,
  run: ExperimentDiagnosisRun,
  cases: ExperimentDiagnosisRecord["cases"],
  primaryMetric: string,
): readonly ResultPayload[] {
  const outputs = record.outputs.filter((item) => item.generationRunId === run.generationRun.id);
  const outputByCase = new Map(outputs.map((item) => [item.caseId, item]));
  if (outputByCase.size !== cases.length || outputs.length !== cases.length) {
    throw incomplete("The selected run does not contain exactly one output for every case.");
  }

  return cases.map((testCase) => {
    const output = outputByCase.get(testCase.id);
    if (!output || output.status !== "succeeded" || output.outputText === null) {
      throw incomplete(`Case ${testCase.id} does not have a successful model output.`);
    }
    const scoreRows = record.scores.filter(
      (item) =>
        item.evaluationRunId === run.evaluationRun.id &&
        item.generationOutputId === output.id &&
        (item.kind === "dimension" || item.kind === "overall"),
    );
    const metrics = new Map<string, MetricPayload>();
    for (const score of scoreRows) {
      if (
        score.normalizedScore === null ||
        !Number.isFinite(score.normalizedScore) ||
        score.normalizedScore < 0 ||
        score.normalizedScore > 1
      ) {
        throw incomplete(`Case ${testCase.id} contains an invalid normalized score.`);
      }
      if (metrics.has(score.metricKey)) {
        throw incomplete(`Case ${testCase.id} contains duplicate metric ${score.metricKey}.`);
      }
      metrics.set(score.metricKey, {
        metric_key: score.metricKey,
        score: score.normalizedScore,
        passed: requirePassDecision(score.passed, testCase.id),
        ...(score.rationale === null ? {} : { reason: score.rationale }),
      });
    }
    const primary = metrics.get(primaryMetric);
    if (!primary) {
      throw incomplete(`Case ${testCase.id} is missing primary metric ${primaryMetric}.`);
    }
    const overall = metrics.get("__overall__");
    if (!overall) throw incomplete(`Case ${testCase.id} is missing its overall score.`);
    return {
      id: output.id,
      test_case_id: testCase.id,
      output_text: output.outputText,
      passed: overall.passed,
      metrics: [...metrics.values()].sort((left, right) =>
        left.metric_key.localeCompare(right.metric_key),
      ),
      metadata: {
        original_case_id: testCase.id,
        repetition: run.generationRun.repetition,
      },
    };
  });
}

function addFailureModes(
  candidate: readonly ResultPayload[],
  baseline: readonly ResultPayload[],
  primaryMetric: string,
): readonly ResultPayload[] {
  const baselineByCase = new Map(baseline.map((item) => [item.test_case_id, item]));
  return candidate.map((item) => {
    const baselineResult = baselineByCase.get(item.test_case_id);
    if (!baselineResult) throw incomplete(`Baseline result missing for ${item.test_case_id}.`);
    const baselineMetrics = new Map(
      baselineResult.metrics.map((metric) => [metric.metric_key, metric.score]),
    );
    const rankedDrops = item.metrics
      .map((metric) => ({
        metricKey: metric.metric_key,
        drop: (baselineMetrics.get(metric.metric_key) ?? metric.score) - metric.score,
      }))
      .filter((entry) => entry.metricKey !== "__overall__" && entry.drop > 0)
      .sort(
        (left, right) => right.drop - left.drop || left.metricKey.localeCompare(right.metricKey),
      );
    const failureMode = rankedDrops[0]?.metricKey ?? primaryMetric;
    return {
      ...item,
      metadata: { ...item.metadata, failure_mode: failureMode },
    };
  });
}

function requirePassDecision(passed: boolean | null, caseId: string): boolean {
  if (passed === null) {
    throw incomplete(`Case ${caseId} is missing a recorded pass decision.`);
  }
  return passed;
}

function promptVersionPayload(selection: ExperimentDiagnosisPromptVersion): JsonObject {
  return {
    id: selection.version.id,
    prompt_id: selection.prompt.id,
    version: selection.version.version,
    // DB contentHash includes block names and a different envelope, so it must not
    // be reused as the optional Core segments hash.
    segments: selection.version.blocks.map((block, ordinal) => ({
      id: block.id,
      kind: block.kind,
      content: block.content,
      ordinal,
      semantic_tags: [...new Set([block.kind, block.name.trim()])].filter((tag) => tag.length > 0),
    })),
  };
}

function modelSnapshot(record: ExperimentDiagnosisRecord, run: ExperimentDiagnosisRun): JsonObject {
  return {
    provider: run.generationRun.provider,
    model: run.generationRun.model,
    model_config: asObject(run.generationRun.modelConfig),
    model_config_hash: run.generationRun.modelConfigHash,
    random_seed: record.experiment.randomSeed,
    repetition: run.generationRun.repetition,
  };
}

function evaluatorSnapshot(
  record: ExperimentDiagnosisRecord,
  run: ExperimentDiagnosisRun,
): JsonObject {
  return {
    evaluator: run.evaluationRun.evaluatorKey,
    evaluator_version: run.evaluationRun.evaluatorVersion,
    evaluator_config: asObject(run.evaluationRun.evaluatorConfig),
    evaluator_config_hash: run.evaluationRun.evaluatorConfigHash,
    framework_version_id: record.frameworkVersion.id,
    framework_content_hash: record.frameworkVersion.contentHash,
  };
}

function latestCompletion(left: ExperimentDiagnosisRun, right: ExperimentDiagnosisRun): Date {
  const values = [
    left.generationRun.completedAt,
    left.evaluationRun.completedAt,
    right.generationRun.completedAt,
    right.evaluationRun.completedAt,
  ];
  if (values.some((value) => value === null)) {
    throw incomplete("The selected runs are missing completion timestamps.");
  }
  return new Date(Math.max(...values.map((value) => value?.getTime() ?? 0)));
}

function normalizeDetection(input: ExperimentDiagnosisDetection | undefined) {
  const result = {
    ...defaultDetection,
    ...(input ?? {}),
    primaryMetric: (input?.primaryMetric ?? defaultDetection.primaryMetric).trim(),
  };
  if (result.primaryMetric.length < 1 || result.primaryMetric.length > 120) {
    throw invalidSelection("primaryMetric must contain 1-120 characters.");
  }
  for (const [name, value] of [
    ["metricDropThreshold", result.metricDropThreshold],
    ["supportRecoveryRatio", result.supportRecoveryRatio],
    ["rejectRecoveryRatio", result.rejectRecoveryRatio],
    ["maxControlDamage", result.maxControlDamage],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw invalidSelection(`${name} must be between 0 and 1.`);
    }
  }
  if (
    !Number.isSafeInteger(result.minTargetCases) ||
    result.minTargetCases < 1 ||
    !Number.isSafeInteger(result.minControlCases) ||
    result.minControlCases < 1
  ) {
    throw invalidSelection("Minimum target and control case counts must be positive integers.");
  }
  if (result.rejectRecoveryRatio > result.supportRecoveryRatio) {
    throw invalidSelection("rejectRecoveryRatio cannot exceed supportRecoveryRatio.");
  }
  return result;
}

function asObject(value: DatabaseJsonValue): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return { value, wrapped: true };
}

function invalidSelection(message: string): ExperimentDiagnosisBuildError {
  return new ExperimentDiagnosisBuildError(422, "DIAGNOSIS_SELECTION_INVALID", message);
}

function incomplete(message: string): ExperimentDiagnosisBuildError {
  return new ExperimentDiagnosisBuildError(409, "DIAGNOSIS_INPUT_INCOMPLETE", message);
}

function confounded(message: string): ExperimentDiagnosisBuildError {
  return new ExperimentDiagnosisBuildError(409, "DIAGNOSIS_COMPARISON_CONFOUNDED", message);
}
