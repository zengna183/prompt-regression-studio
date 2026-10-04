import type { EvaluationDispatchRepository } from "@ai-chat-eval/db";

import type { EvaluationDispatcher } from "./evaluation-dispatcher.js";

export interface EvaluationOutboxProcessor {
  start(): void;
  notify(): void;
  drainOnce(): Promise<{ readonly dispatched: number; readonly rescheduled: number }>;
  stop(): Promise<void>;
}

export interface EvaluationOutboxLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface EvaluationOutboxProcessorOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly staleAfterMs?: number;
  readonly logger?: EvaluationOutboxLogger;
}

/** Reliably hands committed evaluation rows to Redis, including after process restarts. */
export function createEvaluationOutboxProcessor(
  repository: EvaluationDispatchRepository,
  dispatcher: EvaluationDispatcher,
  options: EvaluationOutboxProcessorOptions = {},
): EvaluationOutboxProcessor {
  const intervalMs = boundedInteger(options.intervalMs, 1_000, 100, 60_000, "intervalMs");
  const batchSize = boundedInteger(options.batchSize, 20, 1, 100, "batchSize");
  const concurrency = boundedInteger(options.concurrency, 5, 1, 20, "concurrency");
  const staleAfterMs = boundedInteger(
    options.staleAfterMs,
    60_000,
    10_000,
    60 * 60_000,
    "staleAfterMs",
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<{ readonly dispatched: number; readonly rescheduled: number }> | undefined;
  let scheduled: Promise<void> | undefined;
  let stopping = false;

  async function drain(): Promise<{ readonly dispatched: number; readonly rescheduled: number }> {
    const claims = await repository.claimBatch({ limit: batchSize, staleAfterMs });
    let dispatched = 0;
    let rescheduled = 0;
    for (let offset = 0; offset < claims.length; offset += concurrency) {
      const group = claims.slice(offset, offset + concurrency);
      await Promise.all(
        group.map(async (claim) => {
          try {
            await dispatcher.dispatch(claim.evaluationRunId);
            await repository.markDispatched(claim);
            dispatched += 1;
          } catch (error) {
            rescheduled += 1;
            try {
              await repository.reschedule(claim, "QUEUE_DISPATCH_FAILED");
            } catch (rescheduleError) {
              options.logger?.warn(
                { err: rescheduleError, evaluationRunId: claim.evaluationRunId },
                "could not reschedule evaluation dispatch",
              );
            }
            options.logger?.warn(
              { err: error, evaluationRunId: claim.evaluationRunId },
              "evaluation dispatch failed and will be retried",
            );
          }
        }),
      );
    }
    return { dispatched, rescheduled };
  }

  function drainOnce() {
    if (active) return active;
    active = drain().finally(() => {
      active = undefined;
    });
    return active;
  }

  function notify(): void {
    if (stopping || scheduled) return;
    scheduled = Promise.resolve()
      .then(async () => {
        if (!stopping) await drainOnce();
      })
      .catch((error: unknown) => {
        options.logger?.warn({ err: error }, "evaluation outbox poll failed");
      })
      .finally(() => {
        scheduled = undefined;
      });
  }

  return {
    start() {
      if (timer || stopping) return;
      timer = setInterval(notify, intervalMs);
      timer.unref();
      notify();
    },
    notify,
    drainOnce,
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await scheduled;
      await active;
    },
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}
