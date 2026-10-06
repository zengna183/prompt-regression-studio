import type { Experiment, ExperimentDetail, ExperimentProgress } from "@ai-chat-eval/contracts";
import {
  EntityNotFoundError,
  RepositoryConflictError,
  createExperimentRepository,
  type Database,
  type ExperimentDetailRecord,
  type JsonValue,
} from "@ai-chat-eval/db";

import { ApiError } from "./errors.js";
import type { ExperimentService } from "./experiment-service.js";

export interface ExperimentStartNotifier {
  notify(): void;
}

function dto(experiment: {
  id: string;
  projectId: string;
  datasetVersionId: string;
  frameworkVersionId: string;
  name: string;
  description: string | null;
  status: Experiment["status"];
  randomSeed: number;
  repetitions: number;
  createdAt: Date;
  updatedAt: Date;
}): Experiment {
  return {
    ...experiment,
    createdAt: experiment.createdAt.toISOString(),
    updatedAt: experiment.updatedAt.toISOString(),
  };
}

export function createDatabaseExperimentService(
  db: Database,
  notifier: ExperimentStartNotifier,
): ExperimentService {
  const experiments = createExperimentRepository(db);
  return {
    async list(projectId) {
      return (await experiments.listByProject(projectId)).map(dto);
    },
    async get(projectId, experimentId) {
      const detail = await experiments.getDetail(projectId, experimentId);
      if (!detail) throw new ApiError(404, "NOT_FOUND", `Experiment not found: ${experimentId}`);
      return detailDto(detail);
    },
    async create(projectId, input) {
      try {
        return dto(
          await experiments.create({
            projectId,
            datasetVersionId: input.datasetVersionId,
            frameworkVersionId: input.frameworkVersionId,
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            randomSeed: input.randomSeed,
            ...(input.repetitions === undefined ? {} : { repetitions: input.repetitions }),
            ...(input.config === undefined
              ? {}
              : { config: input.config as Record<string, JsonValue> }),
            promptVersions: input.promptVersions,
          }),
        );
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          throw new ApiError(404, "NOT_FOUND", error.message);
        }
        if (error instanceof TypeError) {
          throw new ApiError(422, "INVALID_EXPERIMENT", error.message);
        }
        throw error;
      }
    },
    async start(projectId, experimentId, input) {
      let started;
      try {
        started = await experiments.start({
          projectId,
          experimentId,
          provider: input.provider,
          model: input.model,
          ...(input.modelConfig === undefined ? {} : { modelConfig: input.modelConfig }),
          ...(input.evaluatorModel === undefined ? {} : { evaluatorModel: input.evaluatorModel }),
        });
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          throw new ApiError(404, "NOT_FOUND", error.message);
        }
        if (error instanceof RepositoryConflictError) {
          throw new ApiError(409, error.code, error.message);
        }
        if (error instanceof TypeError) {
          throw new ApiError(422, "INVALID_EXPERIMENT", error.message);
        }
        throw error;
      }

      // Dispatch records are committed in the same transaction as the runs. The
      // notifier only removes polling latency; recovery does not depend on it.
      notifier.notify();
      if (started.experiment.status === "draft") {
        throw new Error("Started experiment unexpectedly remained in draft status");
      }
      return {
        experimentId: started.experiment.id,
        status: started.experiment.status,
        evaluationRunIds: [...started.evaluationRunIds],
      };
    },
  };
}

function detailDto(detail: ExperimentDetailRecord): ExperimentDetail {
  return {
    experiment: dto(detail.experiment),
    promptVersions: detail.promptVersions.map((promptVersion) => ({ ...promptVersion })),
    progress: deriveExperimentProgress(detail),
    runs: detail.runs.map((run) => ({
      ...run,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
    })),
    failureCode: detail.experiment.failureCode,
    failureMessage: detail.experiment.failureMessage,
    startedAt: detail.experiment.startedAt?.toISOString() ?? null,
    completedAt: detail.experiment.completedAt?.toISOString() ?? null,
  };
}

export function deriveExperimentProgress(detail: ExperimentDetailRecord): ExperimentProgress {
  const plannedRuns = detail.promptVersions.length * detail.experiment.repetitions;
  if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1) {
    throw new Error("Experiment has an invalid planned run count");
  }
  const count = (status: ExperimentDetailRecord["runs"][number]["status"]) =>
    detail.runs.filter((run) => run.status === status).length;
  const succeededRuns = count("succeeded");
  const partiallySucceededRuns = count("partially_succeeded");
  const failedRuns = count("failed");
  const cancelledRuns = count("cancelled");
  const completedRuns = succeededRuns + partiallySucceededRuns + failedRuns + cancelledRuns;
  return {
    plannedRuns,
    createdRuns: detail.runs.length,
    queuedRuns: count("queued"),
    runningRuns: count("running"),
    succeededRuns,
    partiallySucceededRuns,
    failedRuns,
    cancelledRuns,
    completedRuns,
    completionRate: Math.min(1, completedRuns / plannedRuns),
    casesPerRun: detail.datasetCaseCount,
    plannedCaseExecutions: plannedRuns * detail.datasetCaseCount,
    completedCaseExecutions: detail.runs.reduce(
      (sum, run) => sum + run.succeededCount + run.failedCount,
      0,
    ),
  };
}
