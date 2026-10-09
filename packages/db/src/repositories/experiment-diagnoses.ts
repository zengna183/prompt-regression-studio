import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  datasetVersions,
  datasets,
  evaluationCases,
  evaluationFrameworkVersions,
  evaluationRuns,
  experimentPromptVersions,
  experiments,
  generationOutputs,
  generationRuns,
  projects,
  prompts,
  promptVersions,
  scores,
  type JsonValue,
  type PromptBlock,
} from "../schema.js";

export interface ExperimentDiagnosisRecord {
  readonly project: {
    readonly id: string;
    readonly name: string;
  };
  readonly experiment: {
    readonly id: string;
    readonly projectId: string;
    readonly randomSeed: number;
  };
  readonly dataset: {
    readonly id: string;
    readonly name: string;
  };
  readonly datasetVersion: {
    readonly id: string;
    readonly version: number;
    readonly caseCount: number;
  };
  readonly frameworkVersion: {
    readonly id: string;
    readonly contentHash: string;
  };
  readonly promptVersions: readonly ExperimentDiagnosisPromptVersion[];
  readonly cases: readonly ExperimentDiagnosisCase[];
  readonly runs: readonly ExperimentDiagnosisRun[];
  readonly outputs: readonly ExperimentDiagnosisOutput[];
  readonly scores: readonly ExperimentDiagnosisScore[];
}

export interface ExperimentDiagnosisPromptVersion {
  readonly isBaseline: boolean;
  readonly label: string;
  readonly prompt: {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
  };
  readonly version: {
    readonly id: string;
    readonly promptId: string;
    readonly version: number;
    readonly blocks: readonly PromptBlock[];
  };
}

export interface ExperimentDiagnosisCase {
  readonly id: string;
  readonly input: JsonValue;
  readonly expectedOutput: JsonValue | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly sortOrder: number;
}

export interface ExperimentDiagnosisRun {
  readonly generationRun: {
    readonly id: string;
    readonly promptVersionId: string;
    readonly status: string;
    readonly provider: string;
    readonly model: string;
    readonly modelConfig: Readonly<Record<string, JsonValue>>;
    readonly modelConfigHash: string;
    readonly repetition: number;
    readonly completedAt: Date | null;
  };
  readonly evaluationRun: {
    readonly id: string;
    readonly status: string;
    readonly evaluatorKey: string;
    readonly evaluatorVersion: string;
    readonly evaluatorConfig: Readonly<Record<string, JsonValue>>;
    readonly evaluatorConfigHash: string;
    readonly completedAt: Date | null;
  };
}

export interface ExperimentDiagnosisOutput {
  readonly id: string;
  readonly generationRunId: string;
  readonly caseId: string;
  readonly status: string;
  readonly outputText: string | null;
}

export interface ExperimentDiagnosisScore {
  readonly evaluationRunId: string;
  readonly generationOutputId: string;
  readonly kind: "dimension" | "overall" | "rule";
  readonly metricKey: string;
  readonly normalizedScore: number | null;
  readonly passed: boolean | null;
  readonly rationale: string | null;
}

export interface ExperimentDiagnosisRepository {
  get(
    projectId: string,
    experimentId: string,
    repetition: number,
  ): Promise<ExperimentDiagnosisRecord | null>;
}

/**
 * Reads one immutable, repetition-specific experiment snapshot for diagnosis.
 * Domain validation intentionally happens in the API bundle builder so this
 * repository never fabricates missing results or silently picks a run.
 */
export function createExperimentDiagnosisRepository(db: Database): ExperimentDiagnosisRepository {
  return {
    async get(projectId, experimentId, repetition) {
      return db.transaction(
        async (tx) => {
          const [context] = await tx
            .select({
              projectId: projects.id,
              projectName: projects.name,
              experimentId: experiments.id,
              experimentProjectId: experiments.projectId,
              randomSeed: experiments.randomSeed,
              datasetId: datasets.id,
              datasetName: datasets.name,
              datasetVersionId: datasetVersions.id,
              datasetVersion: datasetVersions.version,
              datasetCaseCount: datasetVersions.caseCount,
              frameworkVersionId: evaluationFrameworkVersions.id,
              frameworkContentHash: evaluationFrameworkVersions.contentHash,
            })
            .from(experiments)
            .innerJoin(projects, eq(experiments.projectId, projects.id))
            .innerJoin(datasetVersions, eq(experiments.datasetVersionId, datasetVersions.id))
            .innerJoin(datasets, eq(datasetVersions.datasetId, datasets.id))
            .innerJoin(
              evaluationFrameworkVersions,
              eq(experiments.frameworkVersionId, evaluationFrameworkVersions.id),
            )
            .where(and(eq(experiments.id, experimentId), eq(experiments.projectId, projectId)))
            .limit(1);
          if (!context) return null;

          const selectedVersions = await tx
            .select({
              isBaseline: experimentPromptVersions.isBaseline,
              label: experimentPromptVersions.label,
              promptId: prompts.id,
              promptProjectId: prompts.projectId,
              promptName: prompts.name,
              promptVersionId: promptVersions.id,
              promptVersionPromptId: promptVersions.promptId,
              promptVersion: promptVersions.version,
              blocks: promptVersions.blocks,
            })
            .from(experimentPromptVersions)
            .innerJoin(
              promptVersions,
              eq(experimentPromptVersions.promptVersionId, promptVersions.id),
            )
            .innerJoin(prompts, eq(promptVersions.promptId, prompts.id))
            .where(eq(experimentPromptVersions.experimentId, experimentId))
            .orderBy(asc(experimentPromptVersions.isBaseline), asc(experimentPromptVersions.label));

          const runRows = await tx
            .select({
              generationRunId: generationRuns.id,
              promptVersionId: generationRuns.promptVersionId,
              generationStatus: generationRuns.status,
              provider: generationRuns.provider,
              model: generationRuns.model,
              modelConfig: generationRuns.modelConfig,
              modelConfigHash: generationRuns.modelConfigHash,
              repetition: generationRuns.repetition,
              generationCompletedAt: generationRuns.completedAt,
              evaluationRunId: evaluationRuns.id,
              evaluationStatus: evaluationRuns.status,
              evaluatorKey: evaluationRuns.evaluatorKey,
              evaluatorVersion: evaluationRuns.evaluatorVersion,
              evaluatorConfig: evaluationRuns.evaluatorConfig,
              evaluatorConfigHash: evaluationRuns.evaluatorConfigHash,
              evaluationCompletedAt: evaluationRuns.completedAt,
            })
            .from(generationRuns)
            .innerJoin(evaluationRuns, eq(evaluationRuns.generationRunId, generationRuns.id))
            .where(
              and(
                eq(generationRuns.experimentId, experimentId),
                eq(evaluationRuns.experimentId, experimentId),
                eq(generationRuns.repetition, repetition),
                eq(evaluationRuns.frameworkVersionId, context.frameworkVersionId),
              ),
            )
            .orderBy(asc(generationRuns.promptVersionId), asc(evaluationRuns.id));

          const cases = await tx
            .select({
              id: evaluationCases.id,
              input: evaluationCases.input,
              expectedOutput: evaluationCases.expectedOutput,
              metadata: evaluationCases.metadata,
              sortOrder: evaluationCases.sortOrder,
            })
            .from(evaluationCases)
            .where(eq(evaluationCases.datasetVersionId, context.datasetVersionId))
            .orderBy(asc(evaluationCases.sortOrder), asc(evaluationCases.id));

          const generationRunIds = runRows.map((run) => run.generationRunId);
          const evaluationRunIds = runRows.map((run) => run.evaluationRunId);
          const outputRows =
            generationRunIds.length === 0
              ? []
              : await tx
                  .select({
                    id: generationOutputs.id,
                    generationRunId: generationOutputs.generationRunId,
                    caseId: generationOutputs.caseId,
                    status: generationOutputs.status,
                    outputText: generationOutputs.outputText,
                  })
                  .from(generationOutputs)
                  .where(inArray(generationOutputs.generationRunId, generationRunIds))
                  .orderBy(asc(generationOutputs.generationRunId), asc(generationOutputs.caseId));

          const scoreRows =
            evaluationRunIds.length === 0
              ? []
              : await tx
                  .select({
                    evaluationRunId: scores.evaluationRunId,
                    generationOutputId: scores.generationOutputId,
                    kind: scores.kind,
                    metricKey: scores.metricKey,
                    normalizedScore: scores.normalizedScore,
                    passed: scores.passed,
                    rationale: scores.rationale,
                  })
                  .from(scores)
                  .where(inArray(scores.evaluationRunId, evaluationRunIds))
                  .orderBy(
                    asc(scores.evaluationRunId),
                    asc(scores.generationOutputId),
                    asc(scores.kind),
                    asc(scores.metricKey),
                  );

          return {
            project: { id: context.projectId, name: context.projectName },
            experiment: {
              id: context.experimentId,
              projectId: context.experimentProjectId,
              randomSeed: context.randomSeed,
            },
            dataset: { id: context.datasetId, name: context.datasetName },
            datasetVersion: {
              id: context.datasetVersionId,
              version: context.datasetVersion,
              caseCount: context.datasetCaseCount,
            },
            frameworkVersion: {
              id: context.frameworkVersionId,
              contentHash: context.frameworkContentHash,
            },
            promptVersions: selectedVersions.map((item) => ({
              isBaseline: item.isBaseline,
              label: item.label,
              prompt: {
                id: item.promptId,
                projectId: item.promptProjectId,
                name: item.promptName,
              },
              version: {
                id: item.promptVersionId,
                promptId: item.promptVersionPromptId,
                version: item.promptVersion,
                blocks: item.blocks,
              },
            })),
            cases,
            runs: runRows.map((run) => ({
              generationRun: {
                id: run.generationRunId,
                promptVersionId: run.promptVersionId,
                status: run.generationStatus,
                provider: run.provider,
                model: run.model,
                modelConfig: run.modelConfig,
                modelConfigHash: run.modelConfigHash,
                repetition: run.repetition,
                completedAt: run.generationCompletedAt,
              },
              evaluationRun: {
                id: run.evaluationRunId,
                status: run.evaluationStatus,
                evaluatorKey: run.evaluatorKey,
                evaluatorVersion: run.evaluatorVersion,
                evaluatorConfig: run.evaluatorConfig,
                evaluatorConfigHash: run.evaluatorConfigHash,
                completedAt: run.evaluationCompletedAt,
              },
            })),
            outputs: outputRows,
            scores: scoreRows,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
