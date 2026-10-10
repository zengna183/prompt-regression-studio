import type { CreateExperimentDiagnosis } from "@ai-chat-eval/contracts";
import {
  createAblationRepository,
  createExperimentDiagnosisRepository,
  type Database,
} from "@ai-chat-eval/db";
import type { JsonObject } from "@prompt-regression/diagnosis-engine";

import { ApiError } from "./errors.js";
import { buildRecordedAblationBundle } from "./recorded-ablation.js";
import {
  buildExperimentRegressionBundle,
  ExperimentDiagnosisBuildError,
  type ExperimentDiagnosisSource,
} from "./experiment-diagnosis.js";

export function createDatabaseExperimentDiagnosisSource(db: Database): ExperimentDiagnosisSource {
  const repository = createExperimentDiagnosisRepository(db);
  const ablations = createAblationRepository(db);
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
        if (input.includeAblations) {
          if (repetition !== 1)
            throw new ApiError(
              422,
              "ABLATION_REPETITION_UNSUPPORTED",
              "Recorded interventions currently support repetition 1 only.",
            );
          const links = (await ablations.list(projectId, experimentId)).filter(
            (link) => link.candidatePromptVersionId === input.candidatePromptVersionId,
          );
          if (links.length === 0)
            throw new ApiError(
              409,
              "ABLATION_RESULTS_UNAVAILABLE",
              "No saved interventions exist for this candidate.",
            );
          const records = await Promise.all(
            links.map(async (link) => {
              const saved = await repository.get(projectId, link.experimentId, 1);
              if (!saved)
                throw new ApiError(
                  409,
                  "ABLATION_RESULTS_UNAVAILABLE",
                  "An intervention snapshot is missing.",
                );
              return { link, record: saved };
            }),
          );
          return buildRecordedAblationBundle(record, input, records);
        }
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
