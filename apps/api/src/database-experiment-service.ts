import type { Experiment } from "@ai-chat-eval/contracts";
import {
  EntityNotFoundError,
  createExperimentRepository,
  type Database,
  type JsonValue,
} from "@ai-chat-eval/db";

import { ApiError } from "./errors.js";
import type { ExperimentService } from "./experiment-service.js";

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

export function createDatabaseExperimentService(db: Database): ExperimentService {
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
  };
}
