import { describe, expect, it } from "vitest";

import { assertEvaluationJob } from "./index.js";

describe("assertEvaluationJob", () => {
  it("accepts a supported evaluation job", () => {
    expect(() =>
      assertEvaluationJob({
        type: "evaluation.run",
        evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
        requestedAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  it("rejects unknown job types", () => {
    expect(() => assertEvaluationJob({ type: "made.up" })).toThrow(
      "Unsupported evaluation job type",
    );
  });

  it.each([
    {
      type: "evaluation.run",
      evaluationRunId: "not-a-uuid",
      requestedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      type: "evaluation.run",
      evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
      requestedAt: "not-a-date",
    },
    {
      type: "evaluation.run",
      evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
      requestedAt: "2026-02-30T00:00:00.000Z",
    },
    {
      type: "evaluation.run",
      evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
      requestedAt: "2026-09-12T00:00:00.000Z",
      attackerControlled: true,
    },
  ])("rejects malformed or extended queue payloads", (payload) => {
    expect(() => assertEvaluationJob(payload)).toThrow();
  });

  it("strictly validates reevaluation identifiers", () => {
    expect(() =>
      assertEvaluationJob({
        type: "evaluation.reevaluate",
        evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
        generationRunId: "69d92e0c-cb85-49e9-94c6-c85082377a3a",
        requestedAt: "2026-09-12T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});
