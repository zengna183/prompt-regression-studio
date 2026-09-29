import { describe, expect, it } from "vitest";

import {
  assertCaseBudget,
  assertRunBudget,
  normalizeCreateExperiment,
  normalizeStartExperiment,
} from "./experiments.js";

const input = {
  projectId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
  datasetVersionId: "69d92e0c-cb85-49e9-94c6-c85082377a3a",
  frameworkVersionId: "d159a2ed-d20c-4296-bd7e-28d20b508c1d",
  name: "Support assistant comparison",
  randomSeed: 42,
  promptVersions: [
    {
      promptVersionId: "023edc7e-f870-4228-91a6-5a4e5de0c22a",
      label: "baseline",
      isBaseline: true,
    },
    {
      promptVersionId: "2f4c89f0-3b6b-45d9-8a57-9e7a239bc8d4",
      label: "candidate",
      isBaseline: false,
    },
  ],
} as const;

describe("normalizeCreateExperiment", () => {
  it("makes a stable, bounded comparison plan", () => {
    expect(normalizeCreateExperiment(input)).toMatchObject({
      name: "Support assistant comparison",
      repetitions: 1,
      config: {},
      description: null,
    });
  });

  it.each([
    { ...input, randomSeed: 0.5 },
    { ...input, repetitions: 101 },
    { ...input, promptVersions: [{ ...input.promptVersions[0], isBaseline: false }] },
    {
      ...input,
      promptVersions: [input.promptVersions[0], { ...input.promptVersions[1], label: "baseline" }],
    },
  ])("rejects invalid experiment plans", (invalidInput) => {
    expect(() => normalizeCreateExperiment(invalidInput)).toThrow();
  });
});

describe("experiment start planning", () => {
  it("uses stable configuration hashes and an explicit evaluator model", () => {
    const started = normalizeStartExperiment({
      projectId: input.projectId,
      experimentId: "c373156d-03a8-4537-995e-183b388d2bb4",
      provider: "openai-compatible",
      model: " chat-model ",
      modelConfig: { maxTokens: 512, temperature: 0 },
      evaluatorModel: "judge-model",
    });
    const reordered = normalizeStartExperiment({
      projectId: input.projectId,
      experimentId: "c373156d-03a8-4537-995e-183b388d2bb4",
      provider: "openai-compatible",
      model: "chat-model",
      modelConfig: { temperature: 0, maxTokens: 512 },
      evaluatorModel: "judge-model",
    });

    expect(started.model).toBe("chat-model");
    expect(started.evaluatorConfig).toEqual({ model: "judge-model" });
    expect(started.modelConfigHash).toBe(reordered.modelConfigHash);
    expect(started.evaluatorConfigHash).toBe(reordered.evaluatorConfigHash);
  });

  it("rejects invalid model settings and costly run counts", () => {
    const start = {
      projectId: input.projectId,
      experimentId: "c373156d-03a8-4537-995e-183b388d2bb4",
      provider: "openai-compatible" as const,
      model: "chat-model",
    };
    expect(() => normalizeStartExperiment({ ...start, modelConfig: { temperature: -1 } })).toThrow();
    expect(() => normalizeStartExperiment({ ...start, modelConfig: { maxTokens: 0 } })).toThrow();
    expect(() => normalizeStartExperiment({ ...start, evaluatorModel: " " })).toThrow();
    expect(() => assertRunBudget(2, 50)).not.toThrow();
    expect(() => assertRunBudget(2, 51)).toThrow();
    expect(() => assertRunBudget(0, 1)).toThrow();
    expect(() => assertCaseBudget(100, 50)).not.toThrow();
    expect(() => assertCaseBudget(100, 51)).toThrow();
    expect(() => assertCaseBudget(1, 0)).toThrow();
  });
});
