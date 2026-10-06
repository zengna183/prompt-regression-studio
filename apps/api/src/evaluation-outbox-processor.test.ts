import { describe, expect, it, vi } from "vitest";

import { createEvaluationOutboxProcessor } from "./evaluation-outbox-processor.js";

describe("evaluation outbox processor", () => {
  it("marks successful dispatches and reschedules failures", async () => {
    const successfulId = "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5";
    const failedId = "69d92e0c-cb85-49e9-94c6-c85082377a3a";
    const successfulClaim = { evaluationRunId: successfulId, attempt: 1 };
    const failedClaim = { evaluationRunId: failedId, attempt: 2 };
    const repository = {
      claimBatch: vi.fn(() => Promise.resolve([successfulClaim, failedClaim])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      recordFailure: vi.fn(() => Promise.resolve("rescheduled" as const)),
    };
    const dispatcher = {
      dispatch: vi.fn((id: string) =>
        id === failedId ? Promise.reject(new Error("Redis unavailable")) : Promise.resolve(),
      ),
    };
    const processor = createEvaluationOutboxProcessor(repository, dispatcher);

    await expect(processor.drainOnce()).resolves.toEqual({
      dispatched: 1,
      rescheduled: 1,
      failed: 0,
    });
    expect(repository.markDispatched).toHaveBeenCalledWith(successfulClaim);
    expect(repository.recordFailure).toHaveBeenCalledWith(
      failedClaim,
      "QUEUE_DISPATCH_FAILED",
      10,
    );
  });

  it("coalesces overlapping polls", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = {
      claimBatch: vi.fn(() => blocked.then(() => [])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      recordFailure: vi.fn(() => Promise.resolve("rescheduled" as const)),
    };
    const processor = createEvaluationOutboxProcessor(repository, { dispatch: vi.fn() });

    const first = processor.drainOnce();
    const second = processor.drainOnce();
    release?.();
    await Promise.all([first, second]);
    expect(repository.claimBatch).toHaveBeenCalledTimes(1);
  });

  it("does not start queued polling work after shutdown begins", async () => {
    const repository = {
      claimBatch: vi.fn(() => Promise.resolve([])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      recordFailure: vi.fn(() => Promise.resolve("rescheduled" as const)),
    };
    const processor = createEvaluationOutboxProcessor(repository, { dispatch: vi.fn() });

    processor.notify();
    await processor.stop();

    expect(repository.claimBatch).not.toHaveBeenCalled();
    processor.notify();
    await Promise.resolve();
    expect(repository.claimBatch).not.toHaveBeenCalled();
  });

  it("records a terminal failure after the retry limit", async () => {
    const claim = {
      evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
      attempt: 3,
    };
    const repository = {
      claimBatch: vi.fn(() => Promise.resolve([claim])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      recordFailure: vi.fn(() => Promise.resolve("failed" as const)),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const processor = createEvaluationOutboxProcessor(
      repository,
      { dispatch: vi.fn(() => Promise.reject(new Error("invalid Redis configuration"))) },
      { maxAttempts: 3, logger },
    );

    await expect(processor.drainOnce()).resolves.toEqual({
      dispatched: 0,
      rescheduled: 0,
      failed: 1,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ evaluationRunId: claim.evaluationRunId, attempt: 3 }),
      "evaluation dispatch exhausted its retry limit",
    );
  });

  it("settles an ambiguous dispatch when the evaluation already advanced", async () => {
    const claim = {
      evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
      attempt: 10,
    };
    const repository = {
      claimBatch: vi.fn(() => Promise.resolve([claim])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      recordFailure: vi.fn(() => Promise.resolve("settled" as const)),
    };
    const processor = createEvaluationOutboxProcessor(repository, {
      dispatch: vi.fn(() => Promise.reject(new Error("connection closed after enqueue"))),
    });

    await expect(processor.drainOnce()).resolves.toEqual({
      dispatched: 1,
      rescheduled: 0,
      failed: 0,
    });
  });

  it("rejects an unsafe retry limit", () => {
    const repository = {
      claimBatch: vi.fn(() => Promise.resolve([])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      recordFailure: vi.fn(() => Promise.resolve("rescheduled" as const)),
    };

    expect(() =>
      createEvaluationOutboxProcessor(repository, { dispatch: vi.fn() }, { maxAttempts: 0 }),
    ).toThrow("maxAttempts");
  });
});
