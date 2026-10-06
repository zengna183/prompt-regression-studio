import type { ExperimentDetailRecord } from "@ai-chat-eval/db";
import { describe, expect, it } from "vitest";

import { deriveExperimentProgress } from "./database-experiment-service.js";

describe("deriveExperimentProgress", () => {
  it("reports planned, active, terminal, and case-level progress", () => {
    const detail = {
      experiment: { repetitions: 2 },
      datasetCaseCount: 10,
      promptVersions: [
        { promptVersionId: "baseline", label: "baseline", isBaseline: true },
        { promptVersionId: "candidate", label: "candidate", isBaseline: false },
      ],
      runs: [
        { status: "succeeded", succeededCount: 10, failedCount: 0 },
        { status: "partially_succeeded", succeededCount: 8, failedCount: 2 },
        { status: "running", succeededCount: 0, failedCount: 0 },
        { status: "queued", succeededCount: 0, failedCount: 0 },
      ],
    } as unknown as ExperimentDetailRecord;

    expect(deriveExperimentProgress(detail)).toEqual({
      plannedRuns: 4,
      createdRuns: 4,
      queuedRuns: 1,
      runningRuns: 1,
      succeededRuns: 1,
      partiallySucceededRuns: 1,
      failedRuns: 0,
      cancelledRuns: 0,
      completedRuns: 2,
      completionRate: 0.5,
      casesPerRun: 10,
      plannedCaseExecutions: 40,
      completedCaseExecutions: 20,
    });
  });

  it("rejects a corrupted experiment without selected Prompt versions", () => {
    const detail = {
      experiment: { repetitions: 1 },
      datasetCaseCount: 1,
      promptVersions: [],
      runs: [],
    } as unknown as ExperimentDetailRecord;

    expect(() => deriveExperimentProgress(detail)).toThrow("planned run count");
  });
});
