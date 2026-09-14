import { assertEvaluationJob, type EvaluationJob } from "@ai-chat-eval/queue";
import { UnrecoverableError, type Job } from "bullmq";

import type { Logger } from "./logger.js";

export type EvaluationJobName = EvaluationJob["type"];

export type EvaluationJobEnvelope = Pick<
  Job<EvaluationJob, never, EvaluationJobName>,
  "id" | "name" | "data" | "attemptsMade"
>;

function validateRequiredFields(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("payload must be an object");
  }

  const fields = value as Record<string, unknown>;
  if (typeof fields.evaluationRunId !== "string" || fields.evaluationRunId.trim() === "") {
    throw new Error("evaluationRunId must be a non-empty string");
  }
  if (
    typeof fields.requestedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(fields.requestedAt) ||
    Number.isNaN(Date.parse(fields.requestedAt))
  ) {
    throw new Error("requestedAt must be a valid ISO date-time string");
  }
  if (
    fields.type === "evaluation.reevaluate" &&
    (typeof fields.generationRunId !== "string" || fields.generationRunId.trim() === "")
  ) {
    throw new Error("generationRunId must be a non-empty string for evaluation.reevaluate");
  }
}

function assertJobPayload(job: EvaluationJobEnvelope): EvaluationJob {
  try {
    assertEvaluationJob(job.data);
    validateRequiredFields(job.data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UnrecoverableError(`Invalid evaluation job payload: ${reason}`);
  }

  if (job.name !== job.data.type) {
    throw new UnrecoverableError(
      `Evaluation job name mismatch: received ${job.name}, payload declares ${job.data.type}`,
    );
  }

  return job.data;
}

/**
 * The initial foundation intentionally has no evaluator implementation. Jobs fail
 * loudly and without retrying so an incomplete deployment can never publish a
 * fabricated score or silently report success.
 */
export function processEvaluationJob(job: EvaluationJobEnvelope, logger: Logger): Promise<never> {
  return Promise.resolve().then(() => {
    const data = assertJobPayload(job);
    const jobLogger = logger.child({
      queueJobId: job.id,
      jobName: job.name,
      evaluationRunId: data.evaluationRunId,
      attemptsMade: job.attemptsMade,
    });
    jobLogger.info("Evaluation job received");

    switch (data.type) {
      case "evaluation.run":
        throw new UnrecoverableError(
          "evaluation.run is not implemented in the current milestone; no score was created",
        );
      case "evaluation.reevaluate":
        throw new UnrecoverableError(
          "evaluation.reevaluate is not implemented in the current milestone; no score was created",
        );
      default: {
        const exhaustiveCheck: never = data;
        throw new UnrecoverableError(`Unsupported evaluation job type: ${String(exhaustiveCheck)}`);
      }
    }
  });
}
