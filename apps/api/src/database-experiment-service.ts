import type { Experiment } from "@ai-chat-eval/contracts";
import {
  EntityNotFoundError,
  RepositoryConflictError,
  createExperimentRepository,
  type Database,
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
