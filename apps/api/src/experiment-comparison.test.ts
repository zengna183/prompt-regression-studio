import type { ExperimentComparisonRecord } from "@ai-chat-eval/db";
import { describe, expect, it } from "vitest";

import { buildExperimentComparison } from "./experiment-comparison.js";

describe("buildExperimentComparison", () => {
  it("ranks Prompt versions and calculates paired wins against the baseline", () => {
    const data = comparisonFixture();

    const result = buildExperimentComparison(data);

    expect(result).toMatchObject({
      baselinePromptVersionId: "baseline-id",
      expectedObservationsPerVersion: 3,
      isComplete: true,
    });
    expect(result.versions.map((version) => version.promptVersionId)).toEqual([
      "candidate-id",
      "baseline-id",
    ]);
    expect(result.versions[0]).toMatchObject({
      rank: 1,
      averageScore: 0.7,
      coverageRate: 1,
      pairedComparison: {
        pairedCount: 3,
        wins: 1,
        ties: 1,
        losses: 1,
        winRate: 0.5,
      },
    });
    expect(result.versions[0]?.deltaFromBaseline).toBeCloseTo(0.1);
    expect(result.versions[1]).toMatchObject({ rank: 2, deltaFromBaseline: 0 });
  });

  it("keeps incomplete versions unranked when no score exists", () => {
    const complete = comparisonFixture();
    const data: ExperimentComparisonRecord = {
      ...complete,
      experiment: { ...complete.experiment, status: "running" },
      overall: [],
      dimensions: [],
      pairedObservations: [],
    };

    const result = buildExperimentComparison(data);

    expect(result.isComplete).toBe(false);
    expect(result.versions.every((version) => version.rank === null)).toBe(true);
    expect(result.versions.every((version) => version.averageScore === null)).toBe(true);
  });
});

function comparisonFixture(): ExperimentComparisonRecord {
  return {
    experiment: {
      id: "experiment-id",
      status: "succeeded",
      repetitions: 1,
    } as ExperimentComparisonRecord["experiment"],
    datasetCaseCount: 3,
    promptVersions: [
      { promptVersionId: "baseline-id", label: "baseline", isBaseline: true },
      { promptVersionId: "candidate-id", label: "candidate", isBaseline: false },
    ],
    overall: [
      {
        promptVersionId: "baseline-id",
        observationCount: 3,
        averageScore: 0.6,
        passedCount: 2,
        averageConfidence: 0.9,
      },
      {
        promptVersionId: "candidate-id",
        observationCount: 3,
        averageScore: 0.7,
        passedCount: 2,
        averageConfidence: 0.8,
      },
    ],
    dimensions: [
      {
        promptVersionId: "candidate-id",
        metricKey: "accuracy",
        observationCount: 3,
        averageScore: 0.75,
        passedCount: 2,
        averageConfidence: 0.8,
      },
    ],
    pairedObservations: [
      { promptVersionId: "baseline-id", repetition: 1, caseId: "a", normalizedScore: 0.5 },
      { promptVersionId: "baseline-id", repetition: 1, caseId: "b", normalizedScore: 0.7 },
      { promptVersionId: "baseline-id", repetition: 1, caseId: "c", normalizedScore: 0.6 },
      { promptVersionId: "candidate-id", repetition: 1, caseId: "a", normalizedScore: 0.8 },
      { promptVersionId: "candidate-id", repetition: 1, caseId: "b", normalizedScore: 0.7 },
      { promptVersionId: "candidate-id", repetition: 1, caseId: "c", normalizedScore: 0.4 },
    ],
  };
}
