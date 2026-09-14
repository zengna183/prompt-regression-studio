import { UnrecoverableError } from "bullmq";
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
  it("fails a known but unimplemented job without fabricating a result", async () => {
    const job: EvaluationJobEnvelope = {
      id: "job-1",
      name: "evaluation.run",
      attemptsMade: 0,
      data: {
        type: "evaluation.run",
        evaluationRunId: "run-1",
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
        evaluationRunId: "run-2",
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
      "evaluationRunId must be a non-empty string",
    );
  });
});
