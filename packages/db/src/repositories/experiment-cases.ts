import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { RepositoryDatabase } from "../client.js";
import {
  evaluationCases,
  evaluationFrameworkVersions,
  evaluationRuns,
  experimentPromptVersions,
  experiments,
  generationOutputs,
  generationRuns,
  scores,
} from "../schema.js";

export interface ExperimentCaseQuery {
  readonly offset: number;
  readonly limit: number;
  readonly repetition: number;
}

export function validateExperimentCaseQuery(query: ExperimentCaseQuery) {
  if (
    !Number.isSafeInteger(query.offset) ||
    query.offset < 0 ||
    query.offset > 5000 ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 20 ||
    !Number.isSafeInteger(query.repetition) ||
    query.repetition < 1 ||
    query.repetition > 100
  ) {
    throw new TypeError("Invalid case page: offset 0–5000, limit 1–20, repetition 1–100 required");
  }
}

/** Bounded, read-only snapshot. Never select provider requests, raw responses or credentials. */
export function createExperimentCaseRepository(db: RepositoryDatabase) {
  return {
    async list(projectId: string, experimentId: string, query: ExperimentCaseQuery) {
      validateExperimentCaseQuery(query);
      return db.transaction(
        async (tx) => {
          const [experiment] = await tx
            .select({
              id: experiments.id,
              datasetVersionId: experiments.datasetVersionId,
              repetitions: experiments.repetitions,
              framework: evaluationFrameworkVersions.definition,
            })
            .from(experiments)
            .innerJoin(
              evaluationFrameworkVersions,
              eq(experiments.frameworkVersionId, evaluationFrameworkVersions.id),
            )
            .where(and(eq(experiments.id, experimentId), eq(experiments.projectId, projectId)))
            .limit(1);
          if (!experiment) return null;
          if (query.repetition > experiment.repetitions) {
            throw new TypeError("The requested repetition is not part of this experiment");
          }
          const [total] = await tx
            .select({ value: count() })
            .from(evaluationCases)
            .where(eq(evaluationCases.datasetVersionId, experiment.datasetVersionId));
          const cases = await tx
            .select({
              caseId: evaluationCases.id,
              caseKey: evaluationCases.caseKey,
              name: evaluationCases.name,
              input: evaluationCases.input,
              expectedOutput: evaluationCases.expectedOutput,
            })
            .from(evaluationCases)
            .where(eq(evaluationCases.datasetVersionId, experiment.datasetVersionId))
            .orderBy(asc(evaluationCases.sortOrder), asc(evaluationCases.id))
            .limit(query.limit)
            .offset(query.offset);
          const promptVersions = await tx
            .select({
              promptVersionId: experimentPromptVersions.promptVersionId,
              label: experimentPromptVersions.label,
              isBaseline: experimentPromptVersions.isBaseline,
            })
            .from(experimentPromptVersions)
            .where(eq(experimentPromptVersions.experimentId, experimentId))
            .orderBy(
              desc(experimentPromptVersions.isBaseline),
              asc(experimentPromptVersions.label),
              asc(experimentPromptVersions.promptVersionId),
            );
          const runs = await tx
            .select({
              generationRunId: generationRuns.id,
              promptVersionId: generationRuns.promptVersionId,
              model: generationRuns.model,
              evaluationRunId: evaluationRuns.id,
              evaluationStatus: evaluationRuns.status,
              failureCode: evaluationRuns.failureCode,
              failureMessage: evaluationRuns.failureMessage,
            })
            .from(generationRuns)
            .leftJoin(
              evaluationRuns,
              and(
                eq(evaluationRuns.generationRunId, generationRuns.id),
                eq(evaluationRuns.experimentId, experimentId),
              ),
            )
            .where(
              and(
                eq(generationRuns.experimentId, experimentId),
                eq(generationRuns.repetition, query.repetition),
              ),
            );
          const runIds = runs.map((r) => r.generationRunId);
          const caseIds = cases.map((c) => c.caseId);
          const outputs =
            runIds.length && caseIds.length
              ? await tx
                  .select({
                    id: generationOutputs.id,
                    generationRunId: generationOutputs.generationRunId,
                    caseId: generationOutputs.caseId,
                    status: generationOutputs.status,
                    outputText: generationOutputs.outputText,
                    errorCode: generationOutputs.errorCode,
                    errorMessage: generationOutputs.errorMessage,
                  })
                  .from(generationOutputs)
                  .where(
                    and(
                      inArray(generationOutputs.generationRunId, runIds),
                      inArray(generationOutputs.caseId, caseIds),
                    ),
                  )
              : [];
          const evaluationIds = runs.flatMap((r) => (r.evaluationRunId ? [r.evaluationRunId] : []));
          const grades =
            outputs.length && evaluationIds.length
              ? await tx
                  .select({
                    evaluationRunId: scores.evaluationRunId,
                    generationOutputId: scores.generationOutputId,
                    kind: scores.kind,
                    metricKey: scores.metricKey,
                    score: scores.score,
                    minScore: scores.minScore,
                    maxScore: scores.maxScore,
                    normalizedScore: scores.normalizedScore,
                    passed: scores.passed,
                    confidence: scores.confidence,
                    rationale: scores.rationale,
                    evidence: scores.evidence,
                  })
                  .from(scores)
                  .where(
                    and(
                      inArray(
                        scores.generationOutputId,
                        outputs.map((o) => o.id),
                      ),
                      inArray(scores.evaluationRunId, evaluationIds),
                    ),
                  )
                  .orderBy(asc(scores.kind), asc(scores.metricKey))
              : [];
          return {
            experimentId,
            ...query,
            total: total?.value ?? 0,
            promptVersions,
            items: cases.map((item) => ({
              ...item,
              results: promptVersions.map((version) => {
                const run = runs.find((r) => r.promptVersionId === version.promptVersionId);
                const output = outputs.find(
                  (o) => o.generationRunId === run?.generationRunId && o.caseId === item.caseId,
                );
                return {
                  promptVersionId: version.promptVersionId,
                  generationRunId: run?.generationRunId ?? null,
                  evaluationRunId: run?.evaluationRunId ?? null,
                  model: run?.model ?? null,
                  evaluationStatus: run?.evaluationStatus ?? null,
                  failureCode: run?.failureCode ?? null,
                  failureMessage: run?.failureMessage ?? null,
                  output: output
                    ? {
                        status: output.status,
                        outputText: output.outputText,
                        errorCode: output.errorCode,
                        errorMessage: output.errorMessage,
                      }
                    : null,
                  scores: grades
                    .filter(
                      (s) =>
                        s.evaluationRunId === run?.evaluationRunId &&
                        s.generationOutputId === output?.id,
                    )
                    .map((s) => ({
                      kind: s.kind,
                      metricKey: s.metricKey,
                      metricName:
                        s.kind === "overall"
                          ? "综合分"
                          : (experiment.framework.dimensions.find((d) => d.id === s.metricKey)
                              ?.name ?? s.metricKey),
                      score: s.score,
                      minScore: s.minScore,
                      maxScore: s.maxScore,
                      normalizedScore: s.normalizedScore,
                      passed: s.passed,
                      confidence: s.confidence,
                      rationale: s.rationale,
                      evidence: s.evidence,
                    })),
                };
              }),
            })),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
