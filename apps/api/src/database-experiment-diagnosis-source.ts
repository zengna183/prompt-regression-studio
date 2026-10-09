import type { CreateExperimentDiagnosis } from "@ai-chat-eval/contracts";
import { createExperimentDiagnosisRepository, type Database } from "@ai-chat-eval/db";
import type { JsonObject } from "@prompt-regression/diagnosis-engine";

import { ApiError } from "./errors.js";
import {
  buildExperimentRegressionBundle,
  ExperimentDiagnosisBuildError,
  type ExperimentDiagnosisSource,
} from "./experiment-diagnosis.js";

export function createDatabaseExperimentDiagnosisSource(db: Database): ExperimentDiagnosisSource {
  const repository = createExperimentDiagnosisRepository(db);
  return {
    async build(
      projectId: string,
      experimentId: string,
      input: CreateExperimentDiagnosis,
    ): Promise<JsonObject> {
      const repetition = input.repetition ?? 1;
      const record = await repository.get(projectId, experimentId, repetition);
      if (!record) {
        throw new ApiError(404, "NOT_FOUND", `Experiment not found: ${experimentId}`);
      }
      try {
        return buildExperimentRegressionBundle(record, input);
      } catch (error) {
        if (error instanceof ExperimentDiagnosisBuildError) {
          throw new ApiError(error.statusCode, error.code, error.message);
        }
        throw error;
      }
    },
  };
}
