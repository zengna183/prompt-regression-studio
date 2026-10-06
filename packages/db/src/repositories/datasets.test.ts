import { describe, expect, it } from "vitest";

import {
  hashDatasetCases,
  normalizeEvaluationCases,
  type EvaluationCaseInput,
} from "./datasets.js";

describe("normalizeEvaluationCases", () => {
  it("normalizes ordered cases and creates stable hashes", () => {
    const cases = normalizeEvaluationCases([
      {
        caseKey: " greeting.zh ",
        name: " Chinese greeting ",
        input: { locale: "zh-CN", message: "你好" },
        expectedOutput: { intent: "greeting" },
        metadata: { difficulty: "easy" },
      },
      { caseKey: "greeting.en", input: "hello" },
    ]);

    expect(cases[0]).toMatchObject({
      caseKey: "greeting.zh",
      name: "Chinese greeting",
      sortOrder: 0,
    });
    expect(cases[1]).toMatchObject({
      caseKey: "greeting.en",
      name: null,
      expectedOutput: null,
      metadata: {},
      sortOrder: 1,
    });
    expect(cases.every((item) => /^[0-9a-f]{64}$/u.test(item.contentHash))).toBe(true);
    expect(hashDatasetCases(cases)).toBe(
      hashDatasetCases(
        normalizeEvaluationCases([
          {
            caseKey: "greeting.zh",
            name: "Chinese greeting",
            input: { message: "你好", locale: "zh-CN" },
            expectedOutput: { intent: "greeting" },
            metadata: { difficulty: "easy" },
          },
          { caseKey: "greeting.en", input: "hello" },
        ]),
      ),
    );
  });

  it.each([
    { cases: [] },
    { cases: [{ caseKey: "bad key", input: "hello" }] },
    {
      cases: [
        { caseKey: "duplicate", input: "first" },
        { caseKey: "duplicate", input: "second" },
      ],
    },
    { cases: [{ caseKey: "case-1", input: Number.NaN }] },
    {
      cases: [
        {
          caseKey: "case-1",
          input: "hello",
          metadata: [] as unknown as Record<string, never>,
        },
      ],
    },
  ] satisfies Array<{ cases: readonly EvaluationCaseInput[] }>)(
    "rejects invalid case collections",
    ({ cases }) => {
      expect(() => normalizeEvaluationCases(cases)).toThrow();
    },
  );

  it("makes case order part of the dataset identity", () => {
    const first = normalizeEvaluationCases([
      { caseKey: "a", input: 1 },
      { caseKey: "b", input: 2 },
    ]);
    const second = normalizeEvaluationCases([
      { caseKey: "b", input: 2 },
      { caseKey: "a", input: 1 },
    ]);

    expect(hashDatasetCases(first)).not.toBe(hashDatasetCases(second));
  });
});
