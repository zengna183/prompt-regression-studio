import type { Ablation, CreateAblation } from "@ai-chat-eval/contracts";
import {
  createAblationRepository,
  createExperimentDiagnosisRepository,
  createExperimentRepository,
  EntityNotFoundError,
  RepositoryConflictError,
  VersionContentError,
  type Database,
} from "@ai-chat-eval/db";

import type { ExperimentStartNotifier } from "./database-experiment-service.js";
import { ApiError } from "./errors.js";
import {
  buildExperimentRegressionBundle,
  ExperimentDiagnosisBuildError,
} from "./experiment-diagnosis.js";

export interface AblationService {
  create(projectId: string, experimentId: string, input: CreateAblation): Promise<Ablation>;
  list(projectId: string, experimentId: string): Promise<Ablation[]>;
}

export function createDatabaseAblationService(
  db: Database,
  notifier: ExperimentStartNotifier,
): AblationService {
  const repository = createAblationRepository(db);
  const diagnoses = createExperimentDiagnosisRepository(db);
  const experiments = createExperimentRepository(db);
  const dto = (link: Awaited<ReturnType<typeof repository.create>>): Ablation => ({
    ...link,
    createdAt: link.createdAt.toISOString(),
  });
  return {
    async list(projectId, experimentId) {
      const source = await experiments.getDetail(projectId, experimentId);
      if (!source) throw new ApiError(404, "NOT_FOUND", "Source experiment not found.");
      return (await repository.list(projectId, experimentId)).map(dto);
    },
    async create(projectId, experimentId, input) {
      try {
        const source = await diagnoses.get(projectId, experimentId, 1);
        if (!source) throw new ApiError(404, "NOT_FOUND", "Source experiment not found.");
        // Refuse missing outputs, scores and mixed snapshots before any version or paid job is created.
        buildExperimentRegressionBundle(source, {
          candidatePromptVersionId: input.candidatePromptVersionId,
          repetition: 1,
        });
        const link = await repository.create({
          projectId,
          sourceExperimentId: experimentId,
          candidatePromptVersionId: input.candidatePromptVersionId,
          blockId: input.blockId,
        });
        notifier.notify();
        return dto(link);
      } catch (error) {
        if (error instanceof ExperimentDiagnosisBuildError)
          throw new ApiError(error.statusCode, error.code, error.message);
        if (error instanceof EntityNotFoundError)
          throw new ApiError(404, "NOT_FOUND", error.message);
        if (error instanceof RepositoryConflictError)
          throw new ApiError(409, error.code, error.message);
        if (error instanceof TypeError || error instanceof VersionContentError)
          throw new ApiError(422, "INVALID_ABLATION", error.message);
        throw error;
      }
    },
  };
}
