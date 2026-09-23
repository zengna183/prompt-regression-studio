import { and, asc, eq } from "drizzle-orm";

import type { Database } from "../client.js";
import { EntityNotFoundError } from "../errors.js";
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
  type GenerationOutput,
  type GenerationRun,
  type JsonValue,
  type Score,
} from "../schema.js";

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
  claimEvaluation(evaluationRunId: string): Promise<EvaluationRun | null>;
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

    async claimEvaluation(evaluationRunId) {
      const [claimed] = await db
        .update(evaluationRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(evaluationRuns.id, evaluationRunId), eq(evaluationRuns.status, "queued")))
        .returning();
      return claimed ?? null;
    },

    async startGenerationRun(generationRunId) {
      const [started] = await db
        .update(generationRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(generationRuns.id, generationRunId))
        .returning();
      if (!started) throw new EntityNotFoundError("GenerationRun", generationRunId);
      return started;
    },

    async saveGenerationOutput(input) {
      const values = generationOutputValues(input);
      const [saved] = await db
        .insert(generationOutputs)
        .values(values)
        .onConflictDoUpdate({
          target: [generationOutputs.generationRunId, generationOutputs.caseId],
          set: values,
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
            set: values,
          })
          .returning();
        if (!savedOutput) throw new Error("PostgreSQL did not return the generation output");

        const savedScores: Score[] = [];
        for (const score of scoreInputs) {
          const [created] = await tx
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
        .where(eq(generationRuns.id, generationRunId))
        .returning();
      if (!completed) throw new EntityNotFoundError("GenerationRun", generationRunId);
      return completed;
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
        .where(eq(generationRuns.id, generationRunId))
        .returning();
      if (!failed) throw new EntityNotFoundError("GenerationRun", generationRunId);
      return failed;
    },

    async completeEvaluationRun(evaluationRunId, result) {
      const status = result.failedCount === 0 ? "succeeded" : "partially_succeeded";
      const [completed] = await db
        .update(evaluationRuns)
        .set({
          status,
          requestedCount: result.succeededCount + result.failedCount,
          succeededCount: result.succeededCount,
          failedCount: result.failedCount,
          completedAt: new Date(),
        })
        .where(eq(evaluationRuns.id, evaluationRunId))
        .returning();
      if (!completed) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
      return completed;
    },

    async failEvaluationRun(evaluationRunId, failure) {
      const [failed] = await db
        .update(evaluationRuns)
        .set({
          status: "failed",
          failureCode: failure.code.slice(0, 120),
          failureMessage: failure.message.slice(0, 2_000),
          completedAt: new Date(),
        })
        .where(eq(evaluationRuns.id, evaluationRunId))
        .returning();
      if (!failed) throw new EntityNotFoundError("EvaluationRun", evaluationRunId);
      return failed;
    },
  };
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
