import type { ExperimentDiagnosisRecord } from "@ai-chat-eval/db";
import { describe, expect, it } from "vitest";

import {
  buildExperimentRegressionBundle,
  ExperimentDiagnosisBuildError,
} from "./experiment-diagnosis.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  experiment: "00000000-0000-4000-8000-000000000002",
  dataset: "00000000-0000-4000-8000-000000000003",
  datasetVersion: "00000000-0000-4000-8000-000000000004",
  frameworkVersion: "00000000-0000-4000-8000-000000000005",
  prompt: "00000000-0000-4000-8000-000000000006",
  baselineVersion: "00000000-0000-4000-8000-000000000007",
  candidateVersion: "00000000-0000-4000-8000-000000000008",
  baselineGeneration: "00000000-0000-4000-8000-000000000009",
  candidateGeneration: "00000000-0000-4000-8000-000000000010",
  baselineEvaluation: "00000000-0000-4000-8000-000000000011",
  candidateEvaluation: "00000000-0000-4000-8000-000000000012",
  caseRegression: "00000000-0000-4000-8000-000000000013",
  caseControl: "00000000-0000-4000-8000-000000000014",
  baselineRegressionOutput: "00000000-0000-4000-8000-000000000015",
  baselineControlOutput: "00000000-0000-4000-8000-000000000016",
  candidateRegressionOutput: "00000000-0000-4000-8000-000000000017",
  candidateControlOutput: "00000000-0000-4000-8000-000000000018",
} as const;

describe("buildExperimentRegressionBundle", () => {
  it("creates a deterministic Core bundle from paired experiment results", () => {
    const record = diagnosisRecord();
    const input = { candidatePromptVersionId: ids.candidateVersion };

    const first = buildExperimentRegressionBundle(record, input);
    const second = buildExperimentRegressionBundle(record, input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema_version: "prompt-regression.bundle/v1alpha1",
      diagnosis_requested_at: "2026-10-01T00:02:00.000Z",
      project: { id: ids.project },
      prompt: { id: ids.prompt, project_id: ids.project },
      detection: {
        primary_metric: "__overall__",
        metric_drop_threshold: 0.1,
      },
      mock_ablation_results_by_segment: {},
    });

    const dataset = first.dataset as Record<string, unknown>;
    const testCases = dataset.test_cases as Array<Record<string, unknown>>;
    expect(testCases[0]?.input).toEqual({ value: "question", wrapped: true });
    expect(testCases[0]?.expected).toEqual({ value: "expected", wrapped: true });

    const candidate = first.candidate_eval_run as Record<string, unknown>;
    const results = candidate.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({
      test_case_id: ids.caseRegression,
      passed: false,
      metadata: { failure_mode: "groundedness", repetition: 1 },
    });

    const candidatePrompt = first.candidate_prompt_version as Record<string, unknown>;
    expect(candidatePrompt).not.toHaveProperty("content_hash");
    expect(candidatePrompt.segments).toEqual([
      {
        id: "role",
        kind: "role",
        content: "You are a support assistant.",
        ordinal: 0,
        semantic_tags: ["role", "Assistant role"],
      },
      {
        id: "policy",
        kind: "policy",
        content: "Answer immediately.",
        ordinal: 1,
        semantic_tags: ["policy", "Missing information"],
      },
    ]);
  });

  it("rejects incomplete results instead of inventing missing evidence", () => {
    const record = diagnosisRecord();
    const incomplete = {
      ...record,
      outputs: record.outputs.filter((item) => item.id !== ids.candidateControlOutput),
    };

    const error = captureBuildError(() =>
      buildExperimentRegressionBundle(incomplete, {
        candidatePromptVersionId: ids.candidateVersion,
      }),
    );
    expect(error.code).toBe("DIAGNOSIS_INPUT_INCOMPLETE");
  });

  it("rejects model setting changes as a confounded Prompt comparison", () => {
    const record = diagnosisRecord();
    const confounded = {
      ...record,
      runs: record.runs.map((run) =>
        run.generationRun.promptVersionId === ids.candidateVersion
          ? {
              ...run,
              generationRun: {
                ...run.generationRun,
                modelConfig: { temperature: 0.7 },
                modelConfigHash: "c".repeat(64),
              },
            }
          : run,
      ),
    };

    const error = captureBuildError(() =>
      buildExperimentRegressionBundle(confounded, {
        candidatePromptVersionId: ids.candidateVersion,
      }),
    );
    expect(error.code).toBe("DIAGNOSIS_COMPARISON_CONFOUNDED");
  });

  it("requires a non-baseline version selected by the experiment", () => {
    const error = captureBuildError(() =>
      buildExperimentRegressionBundle(diagnosisRecord(), {
        candidatePromptVersionId: ids.baselineVersion,
      }),
    );
    expect(error.code).toBe("DIAGNOSIS_SELECTION_INVALID");
  });

  it("preserves overall pass decisions when inspecting a single dimension", () => {
    const record = diagnosisRecord();
    const bundle = buildExperimentRegressionBundle(
      {
        ...record,
        scores: record.scores.map((score) =>
          score.generationOutputId === ids.candidateRegressionOutput && score.kind === "overall"
            ? { ...score, normalizedScore: 0.8, passed: true }
            : score,
        ),
      },
      {
        candidatePromptVersionId: ids.candidateVersion,
        detection: { primaryMetric: "groundedness" },
      },
    );
    expect(bundle.candidate_eval_run).toMatchObject({
      results: [expect.objectContaining({ passed: true }), expect.anything()],
    });
  });

  it("refuses to invent a pass decision for ungraded results", () => {
    const record = diagnosisRecord();
    const error = captureBuildError(() =>
      buildExperimentRegressionBundle(
        {
          ...record,
          scores: record.scores.map((score) => ({ ...score, passed: null })),
        },
        { candidatePromptVersionId: ids.candidateVersion },
      ),
    );
    expect(error.code).toBe("DIAGNOSIS_INPUT_INCOMPLETE");
  });
});

function captureBuildError(action: () => unknown): ExperimentDiagnosisBuildError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExperimentDiagnosisBuildError) return error;
    throw error;
  }
  throw new Error("Expected experiment diagnosis bundle construction to fail");
}

function diagnosisRecord(): ExperimentDiagnosisRecord {
  const completedAt = new Date("2026-10-01T00:02:00.000Z");
  const commonRun = {
    status: "succeeded",
    provider: "openai-compatible",
    model: "chat-model",
    modelConfig: { temperature: 0 },
    modelConfigHash: "a".repeat(64),
    repetition: 1,
    completedAt,
  } as const;
  const commonEvaluation = {
    status: "succeeded",
    evaluatorKey: "llm-judge",
    evaluatorVersion: "1",
    evaluatorConfig: { model: "judge-model" },
    evaluatorConfigHash: "b".repeat(64),
    completedAt,
  } as const;

  return {
    project: { id: ids.project, name: "Support" },
    experiment: { id: ids.experiment, projectId: ids.project, randomSeed: 42 },
    dataset: { id: ids.dataset, name: "Regression cases" },
    datasetVersion: { id: ids.datasetVersion, version: 1, caseCount: 2 },
    frameworkVersion: { id: ids.frameworkVersion, contentHash: "f".repeat(64) },
    promptVersions: [
      {
        isBaseline: true,
        label: "baseline",
        prompt: { id: ids.prompt, projectId: ids.project, name: "Support Prompt" },
        version: {
          id: ids.baselineVersion,
          promptId: ids.prompt,
          version: 1,
          blocks: [
            {
              id: "role",
              kind: "role",
              name: "Assistant role",
              content: "You are a support assistant.",
            },
            {
              id: "policy",
              kind: "policy",
              name: "Missing information",
              content: "Ask when required information is missing.",
            },
          ],
        },
      },
      {
        isBaseline: false,
        label: "candidate",
        prompt: { id: ids.prompt, projectId: ids.project, name: "Support Prompt" },
        version: {
          id: ids.candidateVersion,
          promptId: ids.prompt,
          version: 2,
          blocks: [
            {
              id: "role",
              kind: "role",
              name: "Assistant role",
              content: "You are a support assistant.",
            },
            {
              id: "policy",
              kind: "policy",
              name: "Missing information",
              content: "Answer immediately.",
            },
          ],
        },
      },
    ],
    cases: [
      {
        id: ids.caseRegression,
        input: "question",
        expectedOutput: "expected",
        metadata: { cohort: "missing_information" },
        sortOrder: 0,
      },
      {
        id: ids.caseControl,
        input: { question: "known answer" },
        expectedOutput: null,
        metadata: { cohort: "control" },
        sortOrder: 1,
      },
    ],
    runs: [
      {
        generationRun: {
          id: ids.baselineGeneration,
          promptVersionId: ids.baselineVersion,
          ...commonRun,
        },
        evaluationRun: { id: ids.baselineEvaluation, ...commonEvaluation },
      },
      {
        generationRun: {
          id: ids.candidateGeneration,
          promptVersionId: ids.candidateVersion,
          ...commonRun,
        },
        evaluationRun: { id: ids.candidateEvaluation, ...commonEvaluation },
      },
    ],
    outputs: [
      output(ids.baselineRegressionOutput, ids.baselineGeneration, ids.caseRegression, "ask"),
      output(ids.baselineControlOutput, ids.baselineGeneration, ids.caseControl, "known"),
      output(ids.candidateRegressionOutput, ids.candidateGeneration, ids.caseRegression, "guess"),
      output(ids.candidateControlOutput, ids.candidateGeneration, ids.caseControl, "known"),
    ],
    scores: [
      ...scorePair(ids.baselineEvaluation, ids.baselineRegressionOutput, 0.9, 1),
      ...scorePair(ids.baselineEvaluation, ids.baselineControlOutput, 0.8, 0.8),
      ...scorePair(ids.candidateEvaluation, ids.candidateRegressionOutput, 0.2, 0.1),
      ...scorePair(ids.candidateEvaluation, ids.candidateControlOutput, 0.8, 0.8),
    ],
  };
}

function output(id: string, generationRunId: string, caseId: string, outputText: string) {
  return { id, generationRunId, caseId, status: "succeeded", outputText };
}

function scorePair(
  evaluationRunId: string,
  generationOutputId: string,
  overall: number,
  groundedness: number,
) {
  return [
    {
      evaluationRunId,
      generationOutputId,
      kind: "overall" as const,
      metricKey: "__overall__",
      normalizedScore: overall,
      passed: overall >= 0.5,
      rationale: "Overall score",
    },
    {
      evaluationRunId,
      generationOutputId,
      kind: "dimension" as const,
      metricKey: "groundedness",
      normalizedScore: groundedness,
      passed: groundedness >= 0.5,
      rationale: "Groundedness score",
    },
  ];
}
