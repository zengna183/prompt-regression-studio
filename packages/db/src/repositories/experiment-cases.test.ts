import { describe, expect, it } from "vitest";
import { validateExperimentCaseQuery } from "./experiment-cases.js";

describe("bounded experiment evidence query", () => {
  it("accepts one page of a specific repetition", () => {
    expect(() =>
      validateExperimentCaseQuery({ offset: 5000, limit: 20, repetition: 100 }),
    ).not.toThrow();
  });
  it.each([
    { offset: -1, limit: 5, repetition: 1 },
    { offset: 5001, limit: 5, repetition: 1 },
    { offset: 0, limit: 21, repetition: 1 },
    { offset: 0, limit: 0, repetition: 1 },
    { offset: 0, limit: 1.5, repetition: 1 },
    { offset: NaN, limit: 5, repetition: 1 },
    { offset: 0, limit: 5, repetition: 0 },
    { offset: 0, limit: 5, repetition: 101 },
  ])("rejects unbounded or ambiguous pages: %j", (query) => {
    expect(() => validateExperimentCaseQuery(query)).toThrow(TypeError);
  });
});
