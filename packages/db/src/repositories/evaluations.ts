import { and, asc, eq, isNotNull, lt, or } from "drizzle-orm";

import type { Database } from "../client.js";
import { EntityNotFoundError, RepositoryConflictError } from "../errors.js";
import {
  evaluationCases,
  evaluationFrameworkVersions,
  evaluationRuns,
  experiments,
  generationOutputs,
  generationRuns,
  promptVersions,
  scores,
  type EvaluationCase,
  type EvaluationRun,
  type Experiment,
  type GenerationOutput,
  type GenerationRun,
  type JsonValue,
  type Score,
} from "../schema.js";

export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface EvaluationExecutionSnapshot {
  readonly evaluationRun: EvaluationRun;
  readonly generationRun: GenerationRun;
  readonly experiment: typeof experiments.$inferSelect;
  readonly promptVersion: typeof promptVersions.$inferSelect;
  readonly frameworkVersion: typeof evaluationFrameworkVersions.$inferSelect;
  readonly cases: EvaluationCase[];
}

export interface SaveGenerationOutputInput {
  readonly id?: string | undefined;
  readonly generationRunId: string;
  readonly caseId: string;
  readonly request: JsonValue;
  readonly outputText?: string | undefined;
  readonly rawResponse?: JsonValue | undefined;
  readonly outputHash?: string | undefined;
  readonly latencyMs?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly providerRequestId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly status: "succeeded" | "failed";
  readonly attemptCount: number;
}

export interface SaveScoreInput {
  readonly evaluationRunId: string;
  readonly generationOutputId: string;
  readonly kind: "dimension" | "overall" | "rule";
  readonly metricKey: string;
  readonly score: number;
  readonly minScore: number;
  readonly maxScore: number;
  readonly normalizedScore?: number | null;
  readonly passed?: boolean | null;
  readonly confidence?: number | null;
  readonly rationale?: string | null;
  readonly evidence?: JsonValue | null;
  readonly rawResult?: JsonValue | null;
}

export interface EvaluationRepository {
  getExecutionSnapshot(evaluationRunId: string): Promise<EvaluationExecutionSnapshot | null>;
  isCancelled(evaluationRunId: string): Promise<boolean>;
  reserveModelCall(input: {
    readonly evaluationRunId: string;
    readonly phase: "generation" | "evaluator";
    readonly requestBytes: number;
    readonly maxOutputTokens: number;
  }): Promise<void>;
  claimEvaluation(
    evaluationRunId: string,
    options?: { readonly staleAfterMs?: number },
  ): Promise<EvaluationRun | null>;
  startGenerationRun(generationRunId: string): Promise<GenerationRun>;
  saveGenerationOutput(input: SaveGenerationOutputInput): Promise<GenerationOutput>;
  /** Atomically persists a successful output and all of its scores. */
  saveGenerationOutputAndScores(
    output: SaveGenerationOutputInput,
    scores: readonly SaveScoreInput[],
  ): Promise<{ readonly output: GenerationOutput; readonly scores: readonly Score[] }>;
  saveScores(input: readonly SaveScoreInput[]): Promise<Score[]>;
  completeGenerationRun(
    generationRunId: string,
    result: { readonly succeededCount: number; readonly failedCount: number },
  ): Promise<GenerationRun>;
  failGenerationRun(
    generationRunId: string,
    failure: { readonly code: string; readonly message: string },
  ): Promise<GenerationRun>;
  completeEvaluationRun(
    evaluationRunId: string,
    result: { readonly succeededCount: number; readonly failedCount: number },
  ): Promise<EvaluationRun>;
  failEvaluationRun(
    evaluationRunId: string,
    failure: { readonly code: string; readonly message: string },
  ): Promise<EvaluationRun>;
}

export function createEvaluationRepository(db: Database): EvaluationRepository {
  return {
    async getExecutionSnapshot(evaluationRunId) {
      const [joined] = await db
        .select({
          evaluationRun: evaluationRuns,
          generationRun: generationRuns,
          experiment: experiments,
          promptVersion: promptVersions,
          frameworkVersion: evaluationFrameworkVersions,
        })
        .from(evaluationRuns)
        .innerJoin(generationRuns, eq(evaluationRuns.generationRunId, generationRuns.id))
        .innerJoin(experiments, eq(evaluationRuns.experimentId, experiments.id))
        .innerJoin(promptVersions, eq(generationRuns.promptVersionId, promptVersions.id))
        .innerJoin(
          evaluationFrameworkVersions,
          eq(evaluationRuns.frameworkVersionId, evaluationFrameworkVersions.id),
        )
        .where(eq(evaluationRuns.id, evaluationRunId))
        .limit(1);
      if (!joined) return null;

      const cases = await db
        .select()
        .from(evaluationCases)
        .where(eq(evaluationCases.datasetVersionId, joined.experiment.datasetVersionId))
        .orderBy(asc(evaluationCases.sortOrder), asc(evaluationCases.id));
      return { ...joined, cases };
    },

    async isCancelled(evaluationRunId) {
      const [run] = await db
        .select({ status: evaluationRuns.status, experimentStatus: experiments.status })
        .from(evaluationRuns)
        .innerJoin(experiments, eq(evaluationRuns.experimentId, experiments.id))
        .where(eq(evaluationRuns.id, evaluationRunId))
        .limit(1);
      if (!run) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
      return run.status === "cancelled" || run.experimentStatus === "cancelled";
    },

    async reserveModelCall(input) {
      if (
        !Number.isSafeInteger(input.requestBytes) ||
        input.requestBytes < 0 ||
        input.requestBytes > 10_000_000 ||
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 1 ||
        input.maxOutputTokens > 8192
      ) {
        throw new TypeError("Model request size or output cap is invalid");
      }
      await db.transaction(async (tx) => {
        const [run] = await tx
          .select({ experimentId: evaluationRuns.experimentId })
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, input.evaluationRunId))
          .limit(1);
        if (!run) throw new EntityNotFoundError("EvaluationRun", input.evaluationRunId);
        const [experiment] = await tx
          .select({
            id: experiments.id,
            status: experiments.status,
            costBudgetUsd: experiments.costBudgetUsd,
            costReservedUsd: experiments.costReservedUsd,
            costPricing: experiments.costPricing,
          })
          .from(experiments)
          .where(eq(experiments.id, run.experimentId))
          .for("update")
          .limit(1);
        if (!experiment) throw new EntityNotFoundError("Experiment", run.experimentId);
        if (experiment.status !== "queued" && experiment.status !== "running") {
          throw new RepositoryConflictError(
            "EXPERIMENT_STOPPED",
            "The experiment is no longer active.",
          );
        }
        if (experiment.costBudgetUsd === null) return;
        if (!experiment.costPricing) throw new Error("A budgeted experiment has no model pricing");
        const prefix = input.phase === "generation" ? "generation" : "evaluator";
        const inputRate = experiment.costPricing[`${prefix}InputUsdPerMillionTokens`];
        const outputRate = experiment.costPricing[`${prefix}OutputUsdPerMillionTokens`];
        // UTF-8 bytes plus framing allowance conservatively bound tokenized input.
        // This is a provider-independent estimate, not a guarantee of their invoice.
        const reservation = estimateCostReservationUsd(
          input.requestBytes,
          input.maxOutputTokens,
          inputRate,
          outputRate,
        );
        const next =
          Math.round((experiment.costReservedUsd + reservation) * 100_000_000) / 100_000_000;
        if (next > experiment.costBudgetUsd + 1e-9) {
          throw new RepositoryConflictError(
            "COST_BUDGET_EXCEEDED",
            "The next model request would exceed the experiment's estimated USD budget.",
          );
        }
        await tx
          .update(experiments)
          .set({ costReservedUsd: next, updatedAt: new Date() })
          .where(eq(experiments.id, experiment.id));
      });
    },

    async claimEvaluation(evaluationRunId, options) {
      const staleAfterMs = normalizeStaleAfter(options?.staleAfterMs);
      const now = new Date();
      const staleBefore = new Date(now.getTime() - staleAfterMs);
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ experimentId: evaluationRuns.experimentId })
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, evaluationRunId))
          .limit(1);
        if (!candidate) return null;
        const [experiment] = await tx
          .select({
            id: experiments.id,
            status: experiments.status,
            startedAt: experiments.startedAt,
          })
          .from(experiments)
          .where(eq(experiments.id, candidate.experimentId))
          .for("update")
          .limit(1);
        if (!experiment) throw new EntityNotFoundError("Experiment", candidate.experimentId);
        if (experiment.status !== "queued" && experiment.status !== "running") return null;
        const [claimed] = await tx
          .update(evaluationRuns)
          .set({ status: "running", startedAt: now })
          .where(
            and(
              eq(evaluationRuns.id, evaluationRunId),
              or(
                eq(evaluationRuns.status, "queued"),
                and(
                  eq(evaluationRuns.status, "running"),
                  isNotNull(evaluationRuns.startedAt),
                  lt(evaluationRuns.startedAt, staleBefore),
                ),
              ),
            ),
          )
          .returning();
        if (!claimed) return null;

        await tx
          .update(experiments)
          .set({
            status: "running",
            startedAt: experiment.startedAt ?? now,
            completedAt: null,
            failureCode: null,
            failureMessage: null,
            updatedAt: now,
          })
          .where(eq(experiments.id, claimed.experimentId));
        return claimed;
      });
    },

    async startGenerationRun(generationRunId) {
      const [started] = await db
        .update(generationRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "queued")))
        .returning();
      if (started) return started;
      const [existing] = await db
        .select()
        .from(generationRuns)
        .where(eq(generationRuns.id, generationRunId))
        .limit(1);
      if (!existing) throw new EntityNotFoundError("GenerationRun", generationRunId);
      return existing;
    },

    async saveGenerationOutput(input) {
      const values = generationOutputValues(input);
      const [saved] = await db
        .insert(generationOutputs)
        .values(values)
        .onConflictDoUpdate({
          target: [generationOutputs.generationRunId, generationOutputs.caseId],
          set: generationOutputUpdateValues(input),
        })
        .returning();
      if (!saved) throw new Error("PostgreSQL did not return the generation output");
      return saved;
    },

    async saveGenerationOutputAndScores(output, scoreInputs) {
      return db.transaction(async (tx) => {
        const values = generationOutputValues(output);
        const [savedOutput] = await tx
          .insert(generationOutputs)
          .values(values)
          .onConflictDoUpdate({
            target: [generationOutputs.generationRunId, generationOutputs.caseId],
            set: generationOutputUpdateValues(output),
          })
          .returning();
        if (!savedOutput) throw new Error("PostgreSQL did not return the generation output");

        const savedScores: Score[] = [];
        for (const score of scoreInputs) {
          const [created] = await tx
            .insert(scores)
            .values({ ...score, generationOutputId: savedOutput.id })
            .onConflictDoUpdate({
              target: [
                scores.evaluationRunId,
                scores.generationOutputId,
                scores.kind,
                scores.metricKey,
              ],
              set: {
                score: score.score,
                minScore: score.minScore,
                maxScore: score.maxScore,
                normalizedScore: score.normalizedScore,
                passed: score.passed,
                confidence: score.confidence,
                rationale: score.rationale,
                evidence: score.evidence,
                rawResult: score.rawResult,
              },
            })
            .returning();
          if (!created) throw new Error("PostgreSQL did not return the score");
          savedScores.push(created);
        }
        return { output: savedOutput, scores: savedScores };
      });
    },

    async saveScores(input) {
      const saved: Score[] = [];
      for (const score of input) {
        const [created] = await db
          .insert(scores)
          .values(score)
          .onConflictDoUpdate({
            target: [
              scores.evaluationRunId,
              scores.generationOutputId,
              scores.kind,
              scores.metricKey,
            ],
            set: {
              score: score.score,
              minScore: score.minScore,
              maxScore: score.maxScore,
              normalizedScore: score.normalizedScore,
              passed: score.passed,
              confidence: score.confidence,
              rationale: score.rationale,
              evidence: score.evidence,
              rawResult: score.rawResult,
            },
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the score");
        saved.push(created);
      }
      return saved;
    },

    async completeGenerationRun(generationRunId, result) {
      const status = result.failedCount === 0 ? "succeeded" : "partially_succeeded";
      const [completed] = await db
        .update(generationRuns)
        .set({
          status,
          requestedCount: result.succeededCount + result.failedCount,
          succeededCount: result.succeededCount,
          failedCount: result.failedCount,
          completedAt: new Date(),
        })
        .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "running")))
        .returning();
      if (completed) return completed;
      const [existing] = await db
        .select()
        .from(generationRuns)
        .where(eq(generationRuns.id, generationRunId))
        .limit(1);
      if (!existing) throw new EntityNotFoundError("GenerationRun", generationRunId);
      return existing;
    },

    async failGenerationRun(generationRunId, failure) {
      const [failed] = await db
        .update(generationRuns)
        .set({
          status: "failed",
          failureCode: failure.code.slice(0, 120),
          failureMessage: failure.message.slice(0, 2_000),
          completedAt: new Date(),
        })
        .where(and(eq(generationRuns.id, generationRunId), eq(generationRuns.status, "running")))
        .returning();
      if (failed) return failed;
      const [existing] = await db
        .select()
        .from(generationRuns)
        .where(eq(generationRuns.id, generationRunId))
        .limit(1);
      if (!existing) throw new EntityNotFoundError("GenerationRun", generationRunId);
      return existing;
    },

    async completeEvaluationRun(evaluationRunId, result) {
      const status = result.failedCount === 0 ? "succeeded" : "partially_succeeded";
      const now = new Date();
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ experimentId: evaluationRuns.experimentId })
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, evaluationRunId))
          .limit(1);
        if (!candidate) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
        await tx
          .select({ id: experiments.id })
          .from(experiments)
          .where(eq(experiments.id, candidate.experimentId))
          .for("update")
          .limit(1);
        const [completed] = await tx
          .update(evaluationRuns)
          .set({
            status,
            requestedCount: result.succeededCount + result.failedCount,
            succeededCount: result.succeededCount,
            failedCount: result.failedCount,
            completedAt: now,
          })
          .where(and(eq(evaluationRuns.id, evaluationRunId), eq(evaluationRuns.status, "running")))
          .returning();
        if (completed) {
          await synchronizeExperimentStatus(tx, completed.experimentId, now);
          return completed;
        }
        const [existing] = await tx
          .select()
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, evaluationRunId))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
        return existing;
      });
    },

    async failEvaluationRun(evaluationRunId, failure) {
      const now = new Date();
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ experimentId: evaluationRuns.experimentId })
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, evaluationRunId))
          .limit(1);
        if (!candidate) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
        await tx
          .select({ id: experiments.id })
          .from(experiments)
          .where(eq(experiments.id, candidate.experimentId))
          .for("update")
          .limit(1);
        const [failed] = await tx
          .update(evaluationRuns)
          .set({
            status: "failed",
            failureCode: failure.code.slice(0, 120),
            failureMessage: failure.message.slice(0, 2_000),
            completedAt: now,
          })
          .where(and(eq(evaluationRuns.id, evaluationRunId), eq(evaluationRuns.status, "running")))
          .returning();
        if (failed) {
          await synchronizeExperimentStatus(tx, failed.experimentId, now);
          return failed;
        }
        const [existing] = await tx
          .select()
          .from(evaluationRuns)
          .where(eq(evaluationRuns.id, evaluationRunId))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
        return existing;
      });
    },
  };
}

export function estimateCostReservationUsd(
  requestBytes: number,
  maxOutputTokens: number,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
): number {
  if (
    !Number.isSafeInteger(requestBytes) ||
    requestBytes < 0 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    !Number.isFinite(inputUsdPerMillionTokens) ||
    inputUsdPerMillionTokens <= 0 ||
    !Number.isFinite(outputUsdPerMillionTokens) ||
    outputUsdPerMillionTokens <= 0
  ) {
    throw new TypeError("Invalid model cost estimate input");
  }
  return Math.max(
    0.00000001,
    Math.ceil(
      (((requestBytes + 512) * inputUsdPerMillionTokens +
        maxOutputTokens * outputUsdPerMillionTokens) /
        1_000_000) *
        100_000_000,
    ) / 100_000_000,
  );
}

/**
 * Converts child-run state into the single lifecycle state shown for an experiment.
 * Active work always wins; once all runs are terminal, any incomplete run makes the
 * experiment failed or cancelled instead of reporting a misleading success.
 */
export function deriveExperimentStatus(
  statuses: readonly EvaluationRun["status"][],
): Experiment["status"] {
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.length === 0 || statuses.some((status) => status === "queued")) return "queued";
  if (statuses.some((status) => status === "failed" || status === "partially_succeeded")) {
    return "failed";
  }
  if (statuses.some((status) => status === "cancelled")) return "cancelled";
  return "succeeded";
}

export async function synchronizeExperimentStatus(
  tx: DatabaseTransaction,
  experimentId: string,
  now: Date,
): Promise<void> {
  const [experiment] = await tx
    .select({ id: experiments.id, status: experiments.status, startedAt: experiments.startedAt })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .for("update")
    .limit(1);
  if (!experiment) throw new EntityNotFoundError("Experiment", experimentId);
  if (experiment.status === "cancelled") return;

  const runs = await tx
    .select({ status: evaluationRuns.status })
    .from(evaluationRuns)
    .where(eq(evaluationRuns.experimentId, experimentId));
  const status = deriveExperimentStatus(runs.map((run) => run.status));
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  const failed = status === "failed";

  await tx
    .update(experiments)
    .set({
      status,
      startedAt: experiment.startedAt ?? now,
      completedAt: terminal ? now : null,
      failureCode: failed ? "EVALUATION_RUN_FAILED" : null,
      failureMessage: failed ? "One or more evaluation runs did not complete successfully" : null,
      updatedAt: now,
    })
    .where(eq(experiments.id, experimentId));
}

function normalizeStaleAfter(value: number | undefined): number {
  if (value === undefined) return 30 * 60_000;
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 24 * 60 * 60_000) {
    throw new Error("staleAfterMs must be between 60000 and 86400000");
  }
  return value;
}

function generationOutputValues(input: SaveGenerationOutputInput) {
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    generationRunId: input.generationRunId,
    caseId: input.caseId,
    status: input.status,
    request: input.request,
    outputText: input.outputText,
    rawResponse: input.rawResponse,
    outputHash: input.outputHash,
    latencyMs: input.latencyMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    providerRequestId: input.providerRequestId,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    attemptCount: input.attemptCount,
    completedAt: new Date(),
  };
}

/** A retry must never replace an existing output primary key referenced by scores. */
function generationOutputUpdateValues(input: SaveGenerationOutputInput) {
  const values = generationOutputValues(input);
  delete values.id;
  return values;
}
