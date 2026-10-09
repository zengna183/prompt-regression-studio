import type { EvaluationDispatchRepository } from "@ai-chat-eval/db";

import type { EvaluationDispatcher } from "./evaluation-dispatcher.js";

export interface EvaluationOutboxProcessor {
  start(): void;
  notify(): void;
  drainOnce(): Promise<{
    readonly dispatched: number;
    readonly rescheduled: number;
    readonly failed: number;
  }>;
  stop(): Promise<void>;
}

export interface EvaluationOutboxLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface EvaluationOutboxProcessorOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly staleAfterMs?: number;
  readonly maxAttempts?: number;
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
  const maxAttempts = boundedInteger(options.maxAttempts, 10, 1, 100, "maxAttempts");
  let timer: ReturnType<typeof setInterval> | undefined;
  let active:
    | Promise<{
        readonly dispatched: number;
        readonly rescheduled: number;
        readonly failed: number;
      }>
    | undefined;
  let scheduled: Promise<void> | undefined;
  let stopping = false;

  async function drain(): Promise<{
    readonly dispatched: number;
    readonly rescheduled: number;
    readonly failed: number;
  }> {
    const claims = await repository.claimBatch({ limit: batchSize, staleAfterMs });
    let dispatched = 0;
    let rescheduled = 0;
    let failed = 0;
    for (let offset = 0; offset < claims.length; offset += concurrency) {
      const group = claims.slice(offset, offset + concurrency);
      await Promise.all(
        group.map(async (claim) => {
          try {
            await dispatcher.dispatch(claim.evaluationRunId);
            await repository.markDispatched(claim);
            dispatched += 1;
          } catch (error) {
            try {
              const disposition = await repository.recordFailure(
                claim,
                "QUEUE_DISPATCH_FAILED",
                maxAttempts,
              );
              if (disposition === "rescheduled") {
                rescheduled += 1;
                options.logger?.warn(
                  {
                    ...safeErrorFields(error),
                    evaluationRunId: claim.evaluationRunId,
                    attempt: claim.attempt,
                  },
                  "evaluation dispatch failed and will be retried",
                );
              } else if (disposition === "failed") {
                failed += 1;
                options.logger?.error(
                  {
                    ...safeErrorFields(error),
                    evaluationRunId: claim.evaluationRunId,
                    attempt: claim.attempt,
                  },
                  "evaluation dispatch exhausted its retry limit",
                );
              } else if (disposition === "settled") {
                dispatched += 1;
                options.logger?.warn(
                  { evaluationRunId: claim.evaluationRunId, attempt: claim.attempt },
                  "evaluation dispatch response was ambiguous but the run already advanced",
                );
              } else {
                options.logger?.warn(
                  { evaluationRunId: claim.evaluationRunId, attempt: claim.attempt },
                  "evaluation dispatch lease was superseded",
                );
              }
            } catch (rescheduleError) {
              options.logger?.warn(
                {
                  ...safeErrorFields(rescheduleError),
                  evaluationRunId: claim.evaluationRunId,
                },
                "could not reschedule evaluation dispatch",
              );
            }
          }
        }),
      );
    }
    return { dispatched, rescheduled, failed };
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
        options.logger?.warn(safeErrorFields(error), "evaluation outbox poll failed");
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

function safeErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    errorName: error.name || "Error",
    ...(code === undefined ? {} : { errorCode: code.slice(0, 120) }),
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
