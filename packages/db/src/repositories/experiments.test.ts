import { describe, expect, it } from "vitest";

import { normalizeCreateExperiment } from "./experiments.js";

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
