import type {
  Dataset as ApiDataset,
  DatasetVersion as ApiDatasetVersion,
  EvaluationCase as ApiEvaluationCase,
} from "@ai-chat-eval/contracts";
import {
  createDatasetRepository,
  EntityNotFoundError,
  InvalidVersionStateError,
  RepositoryConflictError,
  VersionContentError,
  type Database,
  type Dataset,
  type DatasetVersion,
  type EvaluationCase,
  type EvaluationCaseInput,
  type JsonValue,
} from "@ai-chat-eval/db";

import type { DatasetService } from "./dataset-service.js";
import { ApiError } from "./errors.js";

function datasetDto(dataset: Dataset): ApiDataset {
  return {
    id: dataset.id,
    projectId: dataset.projectId,
    key: dataset.key,
    name: dataset.name,
    description: dataset.description,
    createdAt: dataset.createdAt.toISOString(),
    updatedAt: dataset.updatedAt.toISOString(),
  };
}

function versionDto(version: DatasetVersion): ApiDatasetVersion {
  return {
    id: version.id,
    datasetId: version.datasetId,
    version: version.version,
    status: version.status,
    source: version.source,
    contentHash: version.contentHash,
    caseCount: version.caseCount,
    generationProvenance: version.generationProvenance,
    parentVersionId: version.parentVersionId,
    changeSummary: version.changeSummary,
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

function caseDto(evaluationCase: EvaluationCase): ApiEvaluationCase {
  return {
    id: evaluationCase.id,
    datasetVersionId: evaluationCase.datasetVersionId,
    caseKey: evaluationCase.caseKey,
    name: evaluationCase.name,
    input: evaluationCase.input,
    expectedOutput: evaluationCase.expectedOutput,
    metadata: evaluationCase.metadata,
    contentHash: evaluationCase.contentHash,
    sortOrder: evaluationCase.sortOrder,
    createdAt: evaluationCase.createdAt.toISOString(),
  };
}

async function fromRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      throw new ApiError(404, "NOT_FOUND", error.message);
    }
    if (error instanceof RepositoryConflictError) {
      throw new ApiError(409, error.code, error.message);
    }
    if (error instanceof InvalidVersionStateError) {
      throw new ApiError(409, "INVALID_VERSION_STATE", error.message, { status: error.status });
    }
    if (error instanceof VersionContentError || error instanceof TypeError) {
      throw new ApiError(422, "INVALID_DATASET", error.message);
    }
    throw error;
  }
}

export function createDatabaseDatasetService(db: Database): DatasetService {
  const datasets = createDatasetRepository(db);
  return {
    async list(projectId) {
      return (await fromRepository(() => datasets.listByProject(projectId))).map(datasetDto);
    },
    async create(projectId, input) {
      return datasetDto(
        await fromRepository(() =>
          datasets.create({
            projectId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
          }),
        ),
      );
    },
    async listVersions(datasetId) {
      return (await fromRepository(() => datasets.listVersions(datasetId))).map(versionDto);
    },
    async createVersion(datasetId, input) {
      return versionDto(
        await fromRepository(() =>
          datasets.createVersion(datasetId, {
            source: input.source ?? "manual",
            cases: input.cases as readonly EvaluationCaseInput[],
            ...(input.generationProvenance === undefined
              ? {}
              : { generationProvenance: input.generationProvenance as JsonValue }),
            ...(input.parentVersionId === undefined
              ? {}
              : { parentVersionId: input.parentVersionId }),
            changeSummary: input.changeSummary ?? null,
          }),
        ),
      );
    },
    async listCases(versionId) {
      const version = await fromRepository(() => datasets.getVersionById(versionId));
      if (!version) throw new ApiError(404, "NOT_FOUND", `DatasetVersion not found: ${versionId}`);
      return (await fromRepository(() => datasets.listCases(versionId))).map(caseDto);
    },
    async publishVersion(versionId) {
      return versionDto(await fromRepository(() => datasets.publishVersion(versionId)));
    },
  };
}
