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

/**
 * Schedules a run exactly once from the API boundary. The stable job id makes
 * a client retry safe: BullMQ will not create a second concurrent execution
 * for the same evaluation run.
 */
export async function enqueueEvaluationRun(
  queue: Pick<Queue<EvaluationJob>, "add">,
  evaluationRunId: string,
  requestedAt = new Date().toISOString(),
): Promise<void> {
  assertUuid(evaluationRunId, "evaluationRunId");
  assertIsoDateTime(requestedAt);
  await queue.add(
    "evaluation.run",
    { type: "evaluation.run", evaluationRunId, requestedAt },
    { jobId: `evaluation:${evaluationRunId}` },
  );
}

export function assertEvaluationJob(value: unknown): asserts value is EvaluationJob {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("type" in value)) {
    throw new Error("Evaluation job payload must be an object with a type field");
  }

  const fields = value as Record<string, unknown>;
  const type = fields.type;
  if (type !== "evaluation.run" && type !== "evaluation.reevaluate") {
    throw new Error(`Unsupported evaluation job type: ${String(type)}`);
  }

  const expectedKeys =
    type === "evaluation.run"
      ? ["evaluationRunId", "requestedAt", "type"]
      : ["evaluationRunId", "generationRunId", "requestedAt", "type"];
  const actualKeys = Object.keys(fields).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Evaluation job payload contains missing or unsupported fields");
  }

  assertUuid(fields.evaluationRunId, "evaluationRunId");
  if (type === "evaluation.reevaluate") {
    assertUuid(fields.generationRunId, "generationRunId");
  }
  assertIsoDateTime(fields.requestedAt);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function assertUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error(`${name} must be a valid UUID`);
  }
}

function assertIsoDateTime(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isoDateTimePattern.test(value)) {
    throw new Error("requestedAt must be a valid ISO date-time string");
  }
  const epochMilliseconds = Date.parse(value);
  if (Number.isNaN(epochMilliseconds) || new Date(epochMilliseconds).toISOString() !== value) {
    throw new Error("requestedAt must be a valid ISO date-time string");
  }
}
