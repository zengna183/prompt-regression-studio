import { describe, expect, it } from "vitest";

import type { FrameworkDefinition, PromptBlock } from "./schema.js";
import {
  assertCanPublish,
  compilePrompt,
  hashFrameworkDefinition,
  hashPromptBlocks,
  hashVersionContent,
  nextVersionNumber,
  normalizeFrameworkDefinition,
  normalizePromptBlocks,
  stableStringify,
} from "./versioning.js";

const promptBlocks: PromptBlock[] = [
  { id: "role", kind: "role", name: "Role", content: "You are a careful assistant." },
  { id: "policy", kind: "policy", name: "Policy", content: "Explain uncertainty." },
];

const framework: FrameworkDefinition = {
  levels: [{ id: "L0", name: "Retrieval", description: "Answer explicit information needs." }],
  dimensions: [
    {
      id: "accuracy",
      name: "Accuracy",
      description: "Whether claims are supported.",
      weight: 1,
      scoringGuide: [
        { score: 5, description: "Fully supported" },
        { score: 0, description: "Unsupported" },
      ],
    },
  ],
};

describe("canonical hashing", () => {
  it("sorts object keys while preserving array order", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashVersionContent([1, 2])).not.toBe(hashVersionContent([2, 1]));
  });

  it("rejects values that cannot be reproduced as JSON", () => {
    expect(() => stableStringify({ value: undefined })).toThrow(/undefined/);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => stableStringify(circular)).toThrow(/circular/);
  });
});

describe("Prompt version content", () => {
  it("produces stable hashes and exact source ranges", () => {
    expect(hashPromptBlocks(promptBlocks)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPromptBlocks(promptBlocks)).toBe(hashPromptBlocks(structuredClone(promptBlocks)));

    expect(compilePrompt(promptBlocks)).toEqual({
      content: "You are a careful assistant.\n\nExplain uncertainty.",
      sourceMap: [
        { blockId: "role", start: 0, end: 28 },
        { blockId: "policy", start: 30, end: 50 },
      ],
    });
  });

  it("rejects duplicate stable block ids", () => {
    expect(() => normalizePromptBlocks([...promptBlocks, promptBlocks[0]!])).toThrow(/Duplicate/);
  });
});

describe("framework version content", () => {
  it("sorts score guides before hashing", () => {
    const normalized = normalizeFrameworkDefinition(framework);
    expect(normalized.dimensions[0]?.scoringGuide.map((entry) => entry.score)).toEqual([0, 5]);
    expect(hashFrameworkDefinition(framework)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a framework with no effective weight", () => {
    const invalid: FrameworkDefinition = {
      ...framework,
      dimensions: framework.dimensions.map((dimension) => ({ ...dimension, weight: 0 })),
    };
    expect(() => normalizeFrameworkDefinition(invalid)).toThrow(/positive weight/);
  });
});

describe("version lifecycle", () => {
  it("allocates monotonically increasing version numbers", () => {
    expect(nextVersionNumber(null)).toBe(1);
    expect(nextVersionNumber(9)).toBe(10);
  });

  it("publishes only drafts", () => {
    expect(() => assertCanPublish("draft")).not.toThrow();
    expect(() => assertCanPublish("published")).toThrow(/Only draft/);
    expect(() => assertCanPublish("archived")).toThrow(/Only draft/);
  });
});
