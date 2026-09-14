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
});
