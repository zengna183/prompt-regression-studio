import { describe, expect, it } from "vitest";

import { deriveExperimentStatus } from "./evaluations.js";

describe("deriveExperimentStatus", () => {
  it.each([
    { runs: [], expected: "queued" },
    { runs: ["queued", "succeeded"], expected: "queued" },
    { runs: ["running", "queued"], expected: "running" },
    { runs: ["running", "failed"], expected: "running" },
    { runs: ["succeeded", "succeeded"], expected: "succeeded" },
    { runs: ["succeeded", "partially_succeeded"], expected: "failed" },
    { runs: ["succeeded", "failed"], expected: "failed" },
    { runs: ["succeeded", "cancelled"], expected: "cancelled" },
  ] as const)("maps $runs to $expected", ({ runs, expected }) => {
    expect(deriveExperimentStatus(runs)).toBe(expected);
  });
});
