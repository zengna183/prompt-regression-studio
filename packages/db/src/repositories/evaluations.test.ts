import { describe, expect, it } from "vitest";

import { deriveExperimentStatus, estimateCostReservationUsd } from "./evaluations.js";

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

describe("estimated cost reservation", () => {
  it("includes request framing and the entire allowed output", () => {
    expect(estimateCostReservationUsd(1_000, 2_000, 1, 2)).toBe(0.005512);
  });
  it("rounds upward and rejects invalid prices", () => {
    expect(estimateCostReservationUsd(0, 1, 0.000001, 0.000001)).toBe(0.00000001);
    expect(() => estimateCostReservationUsd(1, 100, -1, 1)).toThrow();
  });
});
