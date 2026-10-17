import { DelayedError, UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "./logger.js";
import { processEvaluationJob, type EvaluationJobEnvelope } from "./processor.js";

function createLoggerStub(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

describe("processEvaluationJob", () => {
  it("defers an active database lease instead of acknowledging or consuming error attempts", async () => {
    const job: EvaluationJobEnvelope = {
      id: "redelivery",
      name: "evaluation.run",
      attemptsMade: 2,
      data: {
        type: "evaluation.run",
        evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
        requestedAt: "2026-09-12T00:00:00.000Z",
      },
    };
    const executor = {
      execute: vi.fn().mockResolvedValue({ status: "busy", succeededCount: 0, failedCount: 0 }),
    };
    const defer = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(
      processEvaluationJob(job, createLoggerStub(), executor, defer),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(defer).toHaveBeenCalledWith(30_000);
    await expect(processEvaluationJob(job, createLoggerStub(), executor)).rejects.toThrow(
      "redelivery",
    );
    defer.mockRejectedValueOnce(new Error("lock lost"));
    await expect(processEvaluationJob(job, createLoggerStub(), executor, defer)).rejects.toThrow(
      "lock lost",
    );
    executor.execute.mockResolvedValueOnce({
      status: "already_claimed",
      succeededCount: 0,
      failedCount: 0,
    });
    await expect(
      processEvaluationJob(job, createLoggerStub(), executor, defer),
    ).resolves.toBeUndefined();
  });
  it("fails a known but unimplemented job without fabricating a result", async () => {
    const job: EvaluationJobEnvelope = {
      id: "job-1",
      name: "evaluation.run",
      attemptsMade: 0,
      data: {
        type: "evaluation.run",
        evaluationRunId: "4f7e9f89-c7c9-4eaf-85f7-0aca6d02acc5",
        requestedAt: "2026-09-12T00:00:00.000Z",
      },
    };

    const error: unknown = await processEvaluationJob(job, createLoggerStub()).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected processEvaluationJob to fail");
    expect(error.name).toContain("Unrecoverable");
    expect(error.message).toContain("no score was created");
  });

  it("rejects a job name and payload mismatch", async () => {
    const job = {
      id: "job-2",
      name: "evaluation.reevaluate",
      attemptsMade: 0,
      data: {
        type: "evaluation.run",
        evaluationRunId: "69d92e0c-cb85-49e9-94c6-c85082377a3a",
        requestedAt: "2026-09-12T00:00:00.000Z",
      },
    } as EvaluationJobEnvelope;

    await expect(processEvaluationJob(job, createLoggerStub())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(processEvaluationJob(job, createLoggerStub())).rejects.toThrow(
      "Evaluation job name mismatch",
    );
  });

  it("rejects an unknown payload explicitly", async () => {
    const job = {
      id: "job-3",
      name: "evaluation.unknown",
      attemptsMade: 0,
      data: { type: "evaluation.unknown" },
    } as unknown as EvaluationJobEnvelope;

    await expect(processEvaluationJob(job, createLoggerStub())).rejects.toThrow(
      "Invalid evaluation job payload",
    );
  });

  it("rejects a supported job type with missing required fields", async () => {
    const job = {
      id: "job-4",
      name: "evaluation.run",
      attemptsMade: 0,
      data: { type: "evaluation.run" },
    } as unknown as EvaluationJobEnvelope;

    await expect(processEvaluationJob(job, createLoggerStub())).rejects.toThrow(
      "missing or unsupported fields",
    );
  });
});
