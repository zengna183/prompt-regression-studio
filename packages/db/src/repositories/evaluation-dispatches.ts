import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { evaluationRunDispatches } from "../schema.js";

export interface ClaimedEvaluationDispatch {
  readonly evaluationRunId: string;
  readonly attempt: number;
}

export interface EvaluationDispatchRepository {
  claimBatch(options?: {
    readonly limit?: number;
    readonly staleAfterMs?: number;
  }): Promise<readonly ClaimedEvaluationDispatch[]>;
  markDispatched(claim: ClaimedEvaluationDispatch): Promise<boolean>;
  reschedule(claim: ClaimedEvaluationDispatch, errorCode: string): Promise<boolean>;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_STALE_AFTER_MS = 60_000;

export function createEvaluationDispatchRepository(db: Database): EvaluationDispatchRepository {
  return {
    async claimBatch(options) {
      const limit = boundedInteger(options?.limit, DEFAULT_BATCH_SIZE, 1, 100, "limit");
      const staleAfterMs = boundedInteger(
        options?.staleAfterMs,
        DEFAULT_STALE_AFTER_MS,
        10_000,
        60 * 60_000,
        "staleAfterMs",
      );
      const now = new Date();
      const staleBefore = new Date(now.getTime() - staleAfterMs);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ evaluationRunId: evaluationRunDispatches.evaluationRunId })
          .from(evaluationRunDispatches)
          .where(
            and(
              lte(evaluationRunDispatches.nextAttemptAt, now),
              or(
                eq(evaluationRunDispatches.status, "pending"),
                and(
                  eq(evaluationRunDispatches.status, "dispatching"),
                  or(
                    isNull(evaluationRunDispatches.lockedAt),
                    lt(evaluationRunDispatches.lockedAt, staleBefore),
                  ),
                ),
              ),
            ),
          )
          .orderBy(asc(evaluationRunDispatches.createdAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        const ids = rows.map((row) => row.evaluationRunId);
        if (ids.length === 0) return [];
        const claimed = await tx
          .update(evaluationRunDispatches)
          .set({
            status: "dispatching",
            lockedAt: now,
            updatedAt: now,
            attemptCount: sql`${evaluationRunDispatches.attemptCount} + 1`,
          })
          .where(inArray(evaluationRunDispatches.evaluationRunId, ids))
          .returning({
            evaluationRunId: evaluationRunDispatches.evaluationRunId,
            attempt: evaluationRunDispatches.attemptCount,
          });
        return claimed;
      });
    },

    async markDispatched(claim) {
      const now = new Date();
      const [updated] = await db
        .update(evaluationRunDispatches)
        .set({
          status: "dispatched",
          dispatchedAt: now,
          lockedAt: null,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(evaluationRunDispatches.evaluationRunId, claim.evaluationRunId),
            eq(evaluationRunDispatches.status, "dispatching"),
            eq(evaluationRunDispatches.attemptCount, claim.attempt),
          ),
        )
        .returning({ evaluationRunId: evaluationRunDispatches.evaluationRunId });
      return updated !== undefined;
    },

    async reschedule(claim, errorCode) {
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, claim.attempt - 1));
      const now = new Date();
      const [updated] = await db
        .update(evaluationRunDispatches)
        .set({
          status: "pending",
          lockedAt: null,
          nextAttemptAt: new Date(now.getTime() + delayMs),
          lastErrorCode: normalizeErrorCode(errorCode),
          updatedAt: now,
        })
        .where(
          and(
            eq(evaluationRunDispatches.evaluationRunId, claim.evaluationRunId),
            eq(evaluationRunDispatches.status, "dispatching"),
            eq(evaluationRunDispatches.attemptCount, claim.attempt),
          ),
        )
        .returning({ evaluationRunId: evaluationRunDispatches.evaluationRunId });
      return updated !== undefined;
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

function normalizeErrorCode(value: string): string {
  const normalized = value.trim().replaceAll(/[^A-Za-z0-9_-]/gu, "_");
  return (normalized || "DISPATCH_FAILED").slice(0, 120);
}
