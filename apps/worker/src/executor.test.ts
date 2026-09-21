import type {
  EvaluationExecutionSnapshot,
  EvaluationRepository,
  EvaluationRun,
  GenerationRun,
  PromptVersion,
  Experiment,
  EvaluationCase,
  EvaluationFrameworkVersion,
  SaveGenerationOutputInput,
} from "@ai-chat-eval/db";
import { describe, expect, it, vi } from "vitest";

import { createEvaluationExecutor, stringifyCaseInput } from "./executor.js";
import type { Logger } from "./logger.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

function createSnapshot(): EvaluationExecutionSnapshot {
  return {
    evaluationRun: { id: "eval-run", evaluatorConfig: {} } as unknown as EvaluationRun,
    generationRun: { id: "generation-run", model: "test-model" } as GenerationRun,
    experiment: { datasetVersionId: "dataset-version" } as Experiment,
    promptVersion: { compiledContent: "Answer briefly." } as PromptVersion,
    frameworkVersion: {
      definition: {
        levels: [],
        dimensions: [
          {
            id: "quality",
            name: "Quality",
            description: "Quality",
            weight: 1,
            scoringGuide: [
              { score: 0, description: "bad" },
              { score: 1, description: "good" },
            ],
          },
        ],
      },
    } as unknown as EvaluationFrameworkVersion,
    cases: [{ id: "case-1", input: { question: "hello" } }] as unknown as EvaluationCase[],
  };
}

function createRepository(snapshot: EvaluationExecutionSnapshot): EvaluationRepository & {
  saved: unknown[];
} {
  const saved: unknown[] = [];
  return {
    saved,
    getExecutionSnapshot: vi.fn(() => Promise.resolve(snapshot)),
    claimEvaluation: vi.fn(() => Promise.resolve(snapshot.evaluationRun)),
    startGenerationRun: vi.fn(() => Promise.resolve(snapshot.generationRun)),
    saveGenerationOutput: vi.fn((input: SaveGenerationOutputInput) => {
      saved.push(input);
      return Promise.resolve(input as never);
    }),
    completeGenerationRun: vi.fn(() => Promise.resolve(snapshot.generationRun)),
    failGenerationRun: vi.fn(() => Promise.resolve(snapshot.generationRun)),
    completeEvaluationRun: vi.fn(() => Promise.resolve(snapshot.evaluationRun)),
    failEvaluationRun: vi.fn(() => Promise.resolve(snapshot.evaluationRun)),
    saveScores: vi.fn(() => Promise.resolve([])),
  };
}

describe("evaluation executor", () => {
  it("calls the model and persists a redacted, hashed output", async () => {
    const repository = createRepository(createSnapshot());
    const responses = [
      {
        id: "request-1",
        model: "test-model",
        choices: [{ message: { content: "world" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
      {
        id: "judge-1",
        model: "test-model",
        choices: [
          {
            message: {
              content: JSON.stringify({
                scores: [
                  {
                    metricKey: "quality",
                    score: 1,
                    rationale: "The answer is useful.",
                    evidence: ["world"],
                    confidence: 0.9,
                  },
                ],
              }),
            },
          },
        ],
      },
    ];
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      fetchImpl: vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(responses.shift()), { status: 200 })),
      ),
    });

    await expect(executor.execute("eval-run", logger)).resolves.toMatchObject({
      status: "completed",
      succeededCount: 1,
      failedCount: 0,
    });
    expect(repository.saved).toHaveLength(1);
    const savedOutput = repository.saved[0];
    if (!savedOutput || typeof savedOutput !== "object") throw new Error("Expected saved output");
    const savedRecord = savedOutput as {
      status?: unknown;
      outputText?: unknown;
      outputHash?: unknown;
    };
    expect(savedRecord.status).toBe("succeeded");
    expect(savedRecord.outputText).toBe("world");
    expect(savedRecord.outputHash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/u));
  });

  it("does not execute a run that another worker already claimed", async () => {
    const repository = createRepository(createSnapshot());
    repository.claimEvaluation = vi.fn(() => Promise.resolve(null));
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      fetchImpl: vi.fn(),
    });

    await expect(executor.execute("eval-run", logger)).resolves.toEqual({
      status: "already_claimed",
      succeededCount: 0,
      failedCount: 0,
    });
    expect(repository.saved).toHaveLength(0);
  });
});

describe("stringifyCaseInput", () => {
  it("preserves strings and serializes structured inputs", () => {
    expect(stringifyCaseInput("hello")).toBe("hello");
    expect(stringifyCaseInput({ question: "hello" })).toBe('{"question":"hello"}');
  });
});
