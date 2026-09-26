import { enqueueEvaluationRun, type EvaluationQueue } from "@ai-chat-eval/queue";
import type { EvaluationRepository } from "@ai-chat-eval/db";

import { notFound } from "./errors.js";

export interface EvaluationDispatcher {
  dispatch(evaluationRunId: string): Promise<void>;
}

/** Bridges the HTTP request to a durable job only after the run is verified. */
export function createDatabaseEvaluationDispatcher(
  repository: Pick<EvaluationRepository, "getExecutionSnapshot">,
  queue: EvaluationQueue,
): EvaluationDispatcher {
  return {
    async dispatch(evaluationRunId) {
      const snapshot = await repository.getExecutionSnapshot(evaluationRunId);
      if (!snapshot) throw notFound("Evaluation run");
      await enqueueEvaluationRun(queue, evaluationRunId);
    },
  };
}
