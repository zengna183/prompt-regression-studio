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
      reschedule: vi.fn(() => Promise.resolve(true)),
    };
    const dispatcher = {
      dispatch: vi.fn((id: string) =>
        id === failedId ? Promise.reject(new Error("Redis unavailable")) : Promise.resolve(),
      ),
    };
    const processor = createEvaluationOutboxProcessor(repository, dispatcher);

    await expect(processor.drainOnce()).resolves.toEqual({ dispatched: 1, rescheduled: 1 });
    expect(repository.markDispatched).toHaveBeenCalledWith(successfulClaim);
    expect(repository.reschedule).toHaveBeenCalledWith(failedClaim, "QUEUE_DISPATCH_FAILED");
  });

  it("coalesces overlapping polls", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = {
      claimBatch: vi.fn(() => blocked.then(() => [])),
      markDispatched: vi.fn(() => Promise.resolve(true)),
      reschedule: vi.fn(() => Promise.resolve(true)),
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
      reschedule: vi.fn(() => Promise.resolve(true)),
    };
    const processor = createEvaluationOutboxProcessor(repository, { dispatch: vi.fn() });

    processor.notify();
    await processor.stop();

    expect(repository.claimBatch).not.toHaveBeenCalled();
    processor.notify();
    await Promise.resolve();
    expect(repository.claimBatch).not.toHaveBeenCalled();
  });
});
