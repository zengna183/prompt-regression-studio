import type { AblationExperiment, ExperimentDiagnosisRecord } from "@ai-chat-eval/db";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

export function recordedFixture() {
  const completedAt = new Date("2026-10-02T00:00:00.000Z");
  const prompt = { id: id(6), projectId: id(1), name: "Support Prompt" };
  const baseline = {
    isBaseline: true,
    label: "baseline",
    prompt,
    version: {
      id: id(7),
      promptId: id(6),
      version: 1,
      blocks: [
        {
          id: "policy",
          kind: "policy" as const,
          name: "Policy",
          content: "Ask for missing information.",
        },
      ],
    },
  };
  const candidate = {
    isBaseline: false,
    label: "candidate",
    prompt,
    version: {
      id: id(8),
      promptId: id(6),
      version: 2,
      blocks: [
        {
          id: "policy",
          kind: "policy" as const,
          name: "Policy",
          content: "Always answer immediately.",
        },
      ],
    },
  };
  const run = (generationId: string, evaluationId: string, versionId: string) => ({
    generationRun: {
      id: generationId,
      promptVersionId: versionId,
      status: "succeeded",
      provider: "openai-compatible",
      model: "test-model",
      modelConfig: { temperature: 0 },
      modelConfigHash: "a".repeat(64),
      repetition: 1,
      completedAt,
    },
    evaluationRun: {
      id: evaluationId,
      status: "succeeded",
      evaluatorKey: "llm-judge",
      evaluatorVersion: "1",
      evaluatorConfig: { model: "test-judge" },
      evaluatorConfigHash: "b".repeat(64),
      completedAt,
    },
  });
  const output = (outputId: string, generationId: string, caseId: string, text: string) => ({
    id: outputId,
    generationRunId: generationId,
    caseId,
    status: "succeeded",
    outputText: text,
  });
  const score = (evaluationId: string, outputId: string, value: number) => ({
    evaluationRunId: evaluationId,
    generationOutputId: outputId,
    kind: "overall" as const,
    metricKey: "__overall__",
    normalizedScore: value,
    passed: value >= 0.5,
    rationale: "Test score",
  });
  const source = {
    project: { id: id(1), name: "Test project" },
    experiment: { id: id(2), projectId: id(1), randomSeed: 42 },
    dataset: { id: id(3), name: "Cases" },
    datasetVersion: { id: id(4), version: 1, caseCount: 2 },
    frameworkVersion: { id: id(5), contentHash: "f".repeat(64) },
    promptVersions: [baseline, candidate],
    cases: [
      {
        id: id(13),
        input: { question: "missing information" },
        expectedOutput: null,
        metadata: {},
        sortOrder: 0,
      },
      {
        id: id(14),
        input: { question: "known answer" },
        expectedOutput: null,
        metadata: {},
        sortOrder: 1,
      },
    ],
    runs: [run(id(9), id(11), id(7)), run(id(10), id(12), id(8))],
    outputs: [
      output(id(15), id(9), id(13), "ask"),
      output(id(16), id(9), id(14), "answer"),
      output(id(17), id(10), id(13), "guess"),
      output(id(18), id(10), id(14), "answer"),
    ],
    scores: [
      score(id(11), id(15), 0.9),
      score(id(11), id(16), 0.8),
      score(id(12), id(17), 0.2),
      score(id(12), id(18), 0.8),
    ],
  } satisfies ExperimentDiagnosisRecord;
  const record = structuredClone(source);
  record.experiment.id = id(21);
  record.promptVersions = structuredClone([
    { ...candidate, isBaseline: true },
    { ...baseline, isBaseline: false, version: { ...baseline.version, id: id(22), version: 3 } },
  ]);
  record.runs = [run(id(23), id(25), candidate.version.id), run(id(24), id(26), id(22))];
  record.outputs = [
    output(id(27), id(23), id(13), "guess"),
    output(id(28), id(23), id(14), "answer"),
    output(id(29), id(24), id(13), "ask"),
    output(id(30), id(24), id(14), "answer"),
  ];
  record.scores = [
    score(id(25), id(27), 0.2),
    score(id(25), id(28), 0.8),
    score(id(26), id(29), 0.9),
    score(id(26), id(30), 0.8),
  ];
  const link: AblationExperiment = {
    id: id(20),
    sourceExperimentId: source.experiment.id,
    candidatePromptVersionId: candidate.version.id,
    revertedBlockId: "policy",
    experimentId: record.experiment.id,
    variantPromptVersionId: id(22),
    createdAt: completedAt,
  };
  return {
    source,
    record,
    link,
    input: { candidatePromptVersionId: candidate.version.id, includeAblations: true },
  };
}
