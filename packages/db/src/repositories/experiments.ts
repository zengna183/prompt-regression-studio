import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "../client.js";
import { EntityNotFoundError, RepositoryConflictError } from "../errors.js";
import {
  datasets,
  datasetVersions,
  evaluationCases,
  evaluationFrameworks,
  evaluationFrameworkVersions,
  evaluationRunDispatches,
  evaluationRuns,
  experimentPromptVersions,
  experiments,
  generationRuns,
  projects,
  prompts,
  promptVersions,
  type EvaluationRun,
  type JsonValue,
} from "../schema.js";
import { hashVersionContent, stableStringify } from "../versioning.js";
import { normalizeDescription } from "./common.js";

export interface ExperimentPromptVersionInput {
  readonly promptVersionId: string;
  readonly label: string;
  readonly isBaseline: boolean;
}

export interface CreateExperimentInput {
  readonly projectId: string;
  readonly datasetVersionId: string;
  readonly frameworkVersionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly randomSeed: number;
  readonly repetitions?: number;
  readonly config?: Record<string, JsonValue>;
  readonly promptVersions: readonly ExperimentPromptVersionInput[];
  readonly createdBy?: string | null;
}

export interface ExperimentRepository {
  create(input: CreateExperimentInput): Promise<typeof experiments.$inferSelect>;
  listByProject(projectId: string): Promise<Array<typeof experiments.$inferSelect>>;
  getDetail(projectId: string, experimentId: string): Promise<ExperimentDetailRecord | null>;
  start(input: StartExperimentInput): Promise<StartedExperiment>;
}

export interface ExperimentDetailRecord {
  readonly experiment: typeof experiments.$inferSelect;
  readonly datasetCaseCount: number;
  readonly promptVersions: ReadonlyArray<{
    readonly promptVersionId: string;
    readonly label: string;
    readonly isBaseline: boolean;
  }>;
  readonly runs: ReadonlyArray<{
    readonly evaluationRunId: string;
    readonly generationRunId: string;
    readonly promptVersionId: string;
    readonly label: string;
    readonly isBaseline: boolean;
    readonly repetition: number;
    readonly status: EvaluationRun["status"];
    readonly requestedCount: number;
    readonly succeededCount: number;
    readonly failedCount: number;
    readonly failureCode: string | null;
    readonly failureMessage: string | null;
    readonly startedAt: Date | null;
    readonly completedAt: Date | null;
  }>;
}

export interface StartExperimentInput {
  readonly projectId: string;
  readonly experimentId: string;
  readonly provider: "openai-compatible";
  readonly model: string;
  readonly modelConfig?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
  };
  readonly evaluatorModel?: string;
}

export interface StartedExperiment {
  readonly experiment: typeof experiments.$inferSelect;
  readonly evaluationRunIds: readonly string[];
}

const MAX_EXPERIMENT_RUNS = 100;
const MAX_CASE_EXECUTIONS = 5_000;

/**
 * Creates a reproducible comparison plan. Every referenced version must be
 * published and belong to the same project, so an experiment cannot silently
 * mix unrelated tests, rubrics, or Prompts.
 */
export function createExperimentRepository(db: Database): ExperimentRepository {
  return {
    async create(input) {
      const normalized = normalizeCreateExperiment(input);
      return db.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, normalized.projectId))
          .limit(1);
        if (!project) throw new EntityNotFoundError("Project", normalized.projectId);

        const [datasetVersion] = await tx
          .select({ id: datasetVersions.id })
          .from(datasetVersions)
          .innerJoin(datasets, eq(datasetVersions.datasetId, datasets.id))
          .where(
            and(
              eq(datasetVersions.id, normalized.datasetVersionId),
              eq(datasets.projectId, normalized.projectId),
              eq(datasetVersions.status, "published"),
            ),
          )
          .limit(1);
        if (!datasetVersion) {
          throw new EntityNotFoundError("Published dataset version", normalized.datasetVersionId);
        }

        const [frameworkVersion] = await tx
          .select({ id: evaluationFrameworkVersions.id })
          .from(evaluationFrameworkVersions)
          .innerJoin(
            evaluationFrameworks,
            eq(evaluationFrameworkVersions.frameworkId, evaluationFrameworks.id),
          )
          .where(
            and(
              eq(evaluationFrameworkVersions.id, normalized.frameworkVersionId),
              eq(evaluationFrameworks.projectId, normalized.projectId),
              eq(evaluationFrameworkVersions.status, "published"),
            ),
          )
          .limit(1);
        if (!frameworkVersion) {
          throw new EntityNotFoundError("Published evaluation framework version", normalized.frameworkVersionId);
        }

        const selectedPromptVersions = await tx
          .select({ id: promptVersions.id })
          .from(promptVersions)
          .innerJoin(prompts, eq(promptVersions.promptId, prompts.id))
          .where(
            and(
              inArray(
                promptVersions.id,
                normalized.promptVersions.map((promptVersion) => promptVersion.promptVersionId),
              ),
              eq(prompts.projectId, normalized.projectId),
              eq(promptVersions.status, "published"),
            ),
          );
        if (selectedPromptVersions.length !== normalized.promptVersions.length) {
          throw new EntityNotFoundError("Published prompt version", "one or more requested versions");
        }

        const [created] = await tx
          .insert(experiments)
          .values({
            projectId: normalized.projectId,
            datasetVersionId: normalized.datasetVersionId,
            frameworkVersionId: normalized.frameworkVersionId,
            name: normalized.name,
            description: normalized.description,
            randomSeed: normalized.randomSeed,
            repetitions: normalized.repetitions,
            config: normalized.config,
            createdBy: normalized.createdBy,
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the created experiment");

        await tx.insert(experimentPromptVersions).values(
          normalized.promptVersions.map((promptVersion) => ({
            experimentId: created.id,
            promptVersionId: promptVersion.promptVersionId,
            label: promptVersion.label,
            isBaseline: promptVersion.isBaseline,
          })),
        );
        return created;
      });
    },

    async listByProject(projectId) {
      return db
        .select()
        .from(experiments)
        .where(eq(experiments.projectId, projectId))
        .orderBy(desc(experiments.createdAt), desc(experiments.id));
    },

    async getDetail(projectId, experimentId) {
      const [experiment] = await db
        .select()
        .from(experiments)
        .where(and(eq(experiments.id, experimentId), eq(experiments.projectId, projectId)))
        .limit(1);
      if (!experiment) return null;

      const [datasetVersion] = await db
        .select({ caseCount: datasetVersions.caseCount })
        .from(datasetVersions)
        .where(eq(datasetVersions.id, experiment.datasetVersionId))
        .limit(1);
      if (!datasetVersion) {
        throw new EntityNotFoundError("DatasetVersion", experiment.datasetVersionId);
      }

      const selectedPromptVersions = await db
        .select({
          promptVersionId: experimentPromptVersions.promptVersionId,
          label: experimentPromptVersions.label,
          isBaseline: experimentPromptVersions.isBaseline,
        })
        .from(experimentPromptVersions)
        .where(eq(experimentPromptVersions.experimentId, experiment.id))
        .orderBy(desc(experimentPromptVersions.isBaseline), asc(experimentPromptVersions.label));

      const runs = await db
        .select({
          evaluationRunId: evaluationRuns.id,
          generationRunId: generationRuns.id,
          promptVersionId: generationRuns.promptVersionId,
          label: experimentPromptVersions.label,
          isBaseline: experimentPromptVersions.isBaseline,
          repetition: generationRuns.repetition,
          status: evaluationRuns.status,
          requestedCount: evaluationRuns.requestedCount,
          succeededCount: evaluationRuns.succeededCount,
          failedCount: evaluationRuns.failedCount,
          failureCode: evaluationRuns.failureCode,
          failureMessage: evaluationRuns.failureMessage,
          startedAt: evaluationRuns.startedAt,
          completedAt: evaluationRuns.completedAt,
        })
        .from(evaluationRuns)
        .innerJoin(generationRuns, eq(evaluationRuns.generationRunId, generationRuns.id))
        .innerJoin(
          experimentPromptVersions,
          and(
            eq(experimentPromptVersions.experimentId, experiment.id),
            eq(experimentPromptVersions.promptVersionId, generationRuns.promptVersionId),
          ),
        )
        .where(eq(evaluationRuns.experimentId, experiment.id))
        .orderBy(
          desc(experimentPromptVersions.isBaseline),
          asc(experimentPromptVersions.label),
          asc(generationRuns.repetition),
        );

      return {
        experiment,
        datasetCaseCount: datasetVersion.caseCount,
        promptVersions: selectedPromptVersions,
        runs,
      };
    },

    async start(input) {
      const config = normalizeStartExperiment(input);
      return db.transaction(async (tx) => {
        const [experiment] = await tx
          .select()
          .from(experiments)
          .where(and(eq(experiments.id, input.experimentId), eq(experiments.projectId, input.projectId)))
          .for("update")
          .limit(1);
        if (!experiment) throw new EntityNotFoundError("Experiment", input.experimentId);

        const selectedPrompts = await tx
          .select({ promptVersionId: experimentPromptVersions.promptVersionId })
          .from(experimentPromptVersions)
          .where(eq(experimentPromptVersions.experimentId, experiment.id));
        assertRunBudget(selectedPrompts.length, experiment.repetitions);

        if (experiment.status !== "draft") {
          const existing = await tx
            .select({
              evaluationRunId: evaluationRuns.id,
              provider: generationRuns.provider,
              model: generationRuns.model,
              modelConfigHash: generationRuns.modelConfigHash,
              evaluatorConfigHash: evaluationRuns.evaluatorConfigHash,
            })
            .from(evaluationRuns)
            .innerJoin(generationRuns, eq(evaluationRuns.generationRunId, generationRuns.id))
            .where(eq(evaluationRuns.experimentId, experiment.id));
          if (
            existing.length !== selectedPrompts.length * experiment.repetitions ||
            existing.some(
              (run) =>
                run.provider !== config.provider ||
                run.model !== config.model ||
                run.modelConfigHash !== config.modelConfigHash ||
                run.evaluatorConfigHash !== config.evaluatorConfigHash,
            )
          ) {
            throw new RepositoryConflictError(
              "EXPERIMENT_ALREADY_STARTED",
              "The experiment was already started with a different configuration.",
            );
          }
          if (experiment.status === "queued" || experiment.status === "running") {
            await tx
              .insert(evaluationRunDispatches)
              .values(existing.map((run) => ({ evaluationRunId: run.evaluationRunId })))
              .onConflictDoNothing();
          }
          return { experiment, evaluationRunIds: existing.map((run) => run.evaluationRunId) };
        }
        const [datasetSize] = await tx
          .select({ caseCount: count() })
          .from(evaluationCases)
          .where(eq(evaluationCases.datasetVersionId, experiment.datasetVersionId));
        assertCaseBudget(selectedPrompts.length * experiment.repetitions, datasetSize?.caseCount ?? 0);

        const evaluationRunIds: string[] = [];
        for (const selectedPrompt of selectedPrompts) {
          for (let repetition = 1; repetition <= experiment.repetitions; repetition += 1) {
            const [generationRun] = await tx
              .insert(generationRuns)
              .values({
                experimentId: experiment.id,
                promptVersionId: selectedPrompt.promptVersionId,
                provider: config.provider,
                model: config.model,
                modelConfig: config.modelConfig,
                modelConfigHash: config.modelConfigHash,
                repetition,
                idempotencyKey: `generation:${experiment.id}:${selectedPrompt.promptVersionId}:${repetition}`,
              })
              .returning({ id: generationRuns.id });
            if (!generationRun) throw new Error("PostgreSQL did not return the generation run");
            const [evaluationRun] = await tx
              .insert(evaluationRuns)
              .values({
                experimentId: experiment.id,
                generationRunId: generationRun.id,
                frameworkVersionId: experiment.frameworkVersionId,
                evaluatorKey: "llm-judge",
                evaluatorVersion: "1",
                evaluatorConfig: config.evaluatorConfig,
                evaluatorConfigHash: config.evaluatorConfigHash,
                idempotencyKey: `evaluation:${generationRun.id}:${experiment.frameworkVersionId}`,
              })
              .returning({ id: evaluationRuns.id });
            if (!evaluationRun) throw new Error("PostgreSQL did not return the evaluation run");
            evaluationRunIds.push(evaluationRun.id);
          }
        }
        await tx
          .insert(evaluationRunDispatches)
          .values(evaluationRunIds.map((evaluationRunId) => ({ evaluationRunId })));
        const [queued] = await tx
          .update(experiments)
          .set({ status: "queued", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(experiments.id, experiment.id))
          .returning();
        if (!queued) throw new Error("PostgreSQL did not return the queued experiment");
        return { experiment: queued, evaluationRunIds };
      });
    },
  };
}

export function normalizeStartExperiment(input: StartExperimentInput) {
  if (input.provider !== "openai-compatible") {
    throw new TypeError("Only the openai-compatible provider is supported");
  }
  const model = input.model.trim();
  if (model.length === 0 || model.length > 240) {
    throw new TypeError("model must be 1-240 characters");
  }
  const modelConfig = input.modelConfig ?? {};
  if (Object.keys(modelConfig).some((key) => key !== "temperature" && key !== "maxTokens")) {
    throw new TypeError("modelConfig contains unsupported options");
  }
  if (
    modelConfig.temperature !== undefined &&
    (!Number.isFinite(modelConfig.temperature) ||
      modelConfig.temperature < 0 ||
      modelConfig.temperature > 2)
  ) {
    throw new TypeError("temperature must be between 0 and 2");
  }
  if (
    modelConfig.maxTokens !== undefined &&
    (!Number.isSafeInteger(modelConfig.maxTokens) ||
      modelConfig.maxTokens < 1 ||
      modelConfig.maxTokens > 8192)
  ) {
    throw new TypeError("maxTokens must be an integer between 1 and 8192");
  }
  const evaluatorModel = (input.evaluatorModel ?? model).trim();
  if (evaluatorModel.length === 0 || evaluatorModel.length > 240) {
    throw new TypeError("evaluatorModel must be 1-240 characters");
  }
  const evaluatorConfig = { model: evaluatorModel };
  return {
    provider: input.provider,
    model,
    modelConfig,
    modelConfigHash: hashVersionContent(modelConfig),
    evaluatorConfig,
    evaluatorConfigHash: hashVersionContent(evaluatorConfig),
  };
}

export function assertRunBudget(promptVersionCount: number, repetitions: number): void {
  const runCount = promptVersionCount * repetitions;
  if (
    !Number.isSafeInteger(runCount) ||
    promptVersionCount < 1 ||
    repetitions < 1 ||
    runCount > MAX_EXPERIMENT_RUNS
  ) {
    throw new TypeError(`An experiment may create 1-${MAX_EXPERIMENT_RUNS} runs`);
  }
}

export function assertCaseBudget(runCount: number, caseCount: number): void {
  const total = runCount * caseCount;
  if (!Number.isSafeInteger(total) || caseCount < 1 || total > MAX_CASE_EXECUTIONS) {
    throw new TypeError(`An experiment may execute 1-${MAX_CASE_EXECUTIONS} evaluation cases`);
  }
}

export function normalizeCreateExperiment(input: CreateExperimentInput) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 240) {
    throw new TypeError("experiment name must be 2-240 characters");
  }
  if (!Number.isSafeInteger(input.randomSeed)) {
    throw new TypeError("randomSeed must be a safe integer");
  }
  const repetitions = input.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new TypeError("repetitions must be an integer between 1 and 100");
  }
  const config = input.config ?? {};
  stableStringify(config);
  const promptVersions = normalizePromptVersions(input.promptVersions);
  const createdBy = normalizeActor(input.createdBy);
  return {
    projectId: input.projectId,
    datasetVersionId: input.datasetVersionId,
    frameworkVersionId: input.frameworkVersionId,
    name,
    description: normalizeDescription(input.description),
    randomSeed: input.randomSeed,
    repetitions,
    config,
    promptVersions,
    createdBy,
  };
}

function normalizePromptVersions(input: readonly ExperimentPromptVersionInput[]) {
  if (input.length === 0 || input.length > 20) {
    throw new TypeError("an experiment must compare 1-20 prompt versions");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  let baselineCount = 0;
  const result = input.map((item) => {
    const id = item.promptVersionId.trim();
    const label = item.label.trim();
    if (id.length === 0) throw new TypeError("promptVersionId is required");
    if (label.length === 0 || label.length > 120) {
      throw new TypeError("prompt version label must be 1-120 characters");
    }
    if (ids.has(id)) throw new TypeError("a prompt version may be included only once");
    if (labels.has(label)) throw new TypeError("prompt version labels must be unique");
    if (typeof item.isBaseline !== "boolean") throw new TypeError("isBaseline must be boolean");
    ids.add(id);
    labels.add(label);
    if (item.isBaseline) baselineCount += 1;
    return { promptVersionId: id, label, isBaseline: item.isBaseline };
  });
  if (baselineCount !== 1) throw new TypeError("an experiment must have exactly one baseline");
  return result;
}

function normalizeActor(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 255) throw new TypeError("createdBy must be at most 255 characters");
  return normalized;
}
