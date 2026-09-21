import { assertEvaluationJob, type EvaluationJob } from "@ai-chat-eval/queue";
import { UnrecoverableError, type Job } from "bullmq";

import type { EvaluationExecutor } from "./executor.js";
import type { Logger } from "./logger.js";

export type EvaluationJobName = EvaluationJob["type"];

export type EvaluationJobEnvelope = Pick<
  Job<EvaluationJob, never, EvaluationJobName>,
  "id" | "name" | "data" | "attemptsMade"
>;

function assertJobPayload(job: EvaluationJobEnvelope): EvaluationJob {
  try {
    assertEvaluationJob(job.data);
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
export function processEvaluationJob(
  job: EvaluationJobEnvelope,
  logger: Logger,
  executor?: EvaluationExecutor,
): Promise<void> {
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
        if (!executor) {
          throw new UnrecoverableError(
            "Evaluation executor is not configured; no score was created",
          );
        }
        return executor.execute(data.evaluationRunId, jobLogger).then(() => undefined);
      case "evaluation.reevaluate":
        throw new UnrecoverableError(
          "evaluation.reevaluate is not implemented in the generation milestone; no score was created",
        );
      default: {
        const exhaustiveCheck: never = data;
        throw new UnrecoverableError(`Unsupported evaluation job type: ${String(exhaustiveCheck)}`);
      }
    }
  });
}
