import { RepositoryConflictError } from "@ai-chat-eval/db";
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

import {
  createEvaluationExecutor,
  deriveEvaluationSeed,
  deriveGenerationSeed,
  stringifyCaseInput,
} from "./executor.js";
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
    generationRun: {
      id: "generation-run",
      model: "test-model",
      modelConfig: { temperature: 0, maxTokens: 128 },
      repetition: 2,
    } as unknown as GenerationRun,
    experiment: { datasetVersionId: "dataset-version", randomSeed: 42 } as Experiment,
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
    isCancelled: vi.fn(() => Promise.resolve(false)),
    reserveModelCall: vi.fn(() => Promise.resolve()),
    claimEvaluation: vi.fn(() => Promise.resolve(snapshot.evaluationRun)),
    startGenerationRun: vi.fn(() => Promise.resolve(snapshot.generationRun)),
    saveGenerationOutput: vi.fn((input: SaveGenerationOutputInput) => {
      saved.push(input);
      return Promise.resolve(input as never);
    }),
    saveGenerationOutputAndScores: vi.fn((input: SaveGenerationOutputInput) => {
      saved.push(input);
      return Promise.resolve({ output: input as never, scores: [] });
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
    const requests: Array<Record<string, unknown>> = [];
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      fetchImpl: vi.fn<typeof fetch>((_input, init) => {
        const body = init?.body;
        requests.push(JSON.parse(typeof body === "string" ? body : "") as Record<string, unknown>);
        return Promise.resolve(new Response(JSON.stringify(responses.shift()), { status: 200 }));
      }),
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
    const expectedSeed = deriveGenerationSeed(42, 2);
    expect(requests[0]).toMatchObject({
      temperature: 0,
      max_tokens: 128,
      seed: expectedSeed,
    });
    expect(savedRecord).toMatchObject({ request: { seed: expectedSeed } });
    expect(requests[1]).toMatchObject({
      temperature: 0,
      seed: deriveEvaluationSeed(42, 2, "case-1"),
    });
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

  it("stops before calling a provider when an experiment was cancelled", async () => {
    const repository = createRepository(createSnapshot());
    repository.isCancelled = vi.fn(() => Promise.resolve(true));
    const fetchImpl = vi.fn<typeof fetch>();
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      fetchImpl,
    });
    await expect(executor.execute("eval-run", logger)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.mocked(repository, true).failEvaluationRun.mock.calls).toHaveLength(0);
  });

  it("aborts an in-flight provider request after cancellation", async () => {
    const repository = createRepository(createSnapshot());
    let checks = 0;
    repository.isCancelled = vi.fn(() => Promise.resolve(++checks > 1));
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      fetchImpl,
    });
    await expect(executor.execute("eval-run", logger)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository, true).failEvaluationRun.mock.calls).toHaveLength(0);
  });

  it("stops a budgeted run before a model call would exceed the limit", async () => {
    const snapshot = createSnapshot();
    const repository = createRepository({
      ...snapshot,
      experiment: { ...snapshot.experiment, costBudgetUsd: 0.01 },
    });
    repository.reserveModelCall = vi.fn(() =>
      Promise.reject(new RepositoryConflictError("COST_BUDGET_EXCEEDED", "Budget exhausted")),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      fetchImpl,
    });
    await expect(executor.execute("eval-run", logger)).rejects.toMatchObject({
      code: "COST_BUDGET_EXCEEDED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.mocked(repository, true).failEvaluationRun.mock.calls[0]).toEqual([
      "eval-run",
      expect.objectContaining({ code: "COST_BUDGET_EXCEEDED" }),
    ]);
  });

  it("retries transient provider failures without duplicating persisted cases", async () => {
    const repository = createRepository(createSnapshot());
    const responses = [
      new Response("temporary outage", { status: 503 }),
      new Response(
        JSON.stringify({
          id: "request-1",
          model: "test-model",
          choices: [{ message: { content: "world" } }],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
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
                      rationale: "good",
                      evidence: ["world"],
                      confidence: 1,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ];
    const executor = createEvaluationExecutor({
      repository,
      baseUrl: "https://api.example.com",
      apiKey: "provider-test-key-that-is-long-enough",
      production: true,
      allowPrivateNetwork: false,
      timeoutMs: 10_000,
      retryDelayMs: 0,
      fetchImpl: vi.fn(() =>
        Promise.resolve(responses.shift() ?? new Response("unexpected", { status: 500 })),
      ),
    });

    await expect(executor.execute("eval-run", logger)).resolves.toMatchObject({
      succeededCount: 1,
      failedCount: 0,
    });
    expect(repository.saved).toHaveLength(1);
  });
});

describe("stringifyCaseInput", () => {
  it("preserves strings and serializes structured inputs", () => {
    expect(stringifyCaseInput("hello")).toBe("hello");
    expect(stringifyCaseInput({ question: "hello" })).toBe('{"question":"hello"}');
  });
});

describe("deriveGenerationSeed", () => {
  it("is stable and separates repetitions while staying in provider-safe range", () => {
    const first = deriveGenerationSeed(42, 1);
    expect(deriveGenerationSeed(42, 1)).toBe(first);
    expect(deriveGenerationSeed(42, 2)).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(2_147_483_647);
  });

  it.each([
    [0.5, 1],
    [42, 0],
    [42, 1.5],
  ])("rejects invalid seed inputs (%s, %s)", (randomSeed, repetition) => {
    expect(() => deriveGenerationSeed(randomSeed, repetition)).toThrow();
  });
});

describe("deriveEvaluationSeed", () => {
  it("is stable per case and separates different cases", () => {
    const first = deriveEvaluationSeed(42, 2, "case-1");
    expect(deriveEvaluationSeed(42, 2, "case-1")).toBe(first);
    expect(deriveEvaluationSeed(42, 2, "case-2")).not.toBe(first);
  });
});
