import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const EVALUATION_QUEUE_NAME = "evaluation-runs";

export interface RunEvaluationJob {
  type: "evaluation.run";
  evaluationRunId: string;
  requestedAt: string;
}

export interface ReevaluateGenerationJob {
  type: "evaluation.reevaluate";
  evaluationRunId: string;
  generationRunId: string;
  requestedAt: string;
}

export type EvaluationJob = RunEvaluationJob | ReevaluateGenerationJob;

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

export function createEvaluationQueue(redisUrl: string): Queue<EvaluationJob> {
  const connection = createRedisConnection(redisUrl);
  return new Queue<EvaluationJob>(EVALUATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    },
  });
}

export function assertEvaluationJob(value: unknown): asserts value is EvaluationJob {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Evaluation job payload must be an object with a type field");
  }

  const type = (value as { type?: unknown }).type;
  if (type !== "evaluation.run" && type !== "evaluation.reevaluate") {
    throw new Error(`Unsupported evaluation job type: ${String(type)}`);
  }
}
