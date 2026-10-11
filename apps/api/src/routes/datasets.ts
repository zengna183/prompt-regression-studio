import {
  CreateDatasetSchema,
  CreateDatasetVersionSchema,
  DatasetSchema,
  DatasetVersionSchema,
  DatasetImportPreviewRequestSchema,
  DatasetImportRequestSchema,
  DatasetImportPreviewSchema,
  GenerateDatasetCasesRequestSchema,
  EvaluationCaseSchema,
  UuidSchema,
} from "@ai-chat-eval/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { DatasetService } from "../dataset-service.js";
import type { DatasetCaseGenerator } from "../dataset-generation.js";
import { ApiError } from "../errors.js";
import { DATASET_IMPORT_VERSION, parseDatasetImport } from "../dataset-import.js";

const ProjectParams = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });
const DatasetParams = Type.Object({ datasetId: UuidSchema }, { additionalProperties: false });
const VersionParams = Type.Object({ versionId: UuidSchema }, { additionalProperties: false });

export function datasetRoutes(
  service: DatasetService | undefined,
  generator?: DatasetCaseGenerator,
): FastifyPluginAsyncTypebox {
  return (app) => {
    function requireService(): DatasetService {
      if (!service) {
        throw new ApiError(503, "DATASETS_UNAVAILABLE", "Dataset management is not configured.");
      }
      return service;
    }

    app.get(
      "/v1/datasets/generation-availability",
      {
        schema: {
          tags: ["datasets"],
          response: {
            200: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
          },
        },
      },
      () => ({ enabled: Boolean(service && generator) }),
    );

    app.get(
      "/v1/projects/:projectId/datasets",
      {
        schema: {
          tags: ["datasets"],
          params: ProjectParams,
          response: { 200: Type.Array(DatasetSchema) },
        },
      },
      async (request) => requireService().list(request.params.projectId),
    );

    app.post(
      "/v1/projects/:projectId/datasets",
      {
        schema: {
          tags: ["datasets"],
          params: ProjectParams,
          body: CreateDatasetSchema,
          response: { 201: DatasetSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await requireService().create(request.params.projectId, request.body)),
    );

    app.get(
      "/v1/datasets/:datasetId/versions",
      {
        schema: {
          tags: ["datasets"],
          params: DatasetParams,
          response: { 200: Type.Array(DatasetVersionSchema) },
        },
      },
      async (request) => requireService().listVersions(request.params.datasetId),
    );

    app.post(
      "/v1/datasets/:datasetId/versions",
      {
        config: { rateLimit: { max: 20, timeWindow: 60_000 } },
        schema: {
          tags: ["datasets"],
          params: DatasetParams,
          body: CreateDatasetVersionSchema,
          response: { 201: DatasetVersionSchema },
        },
      },
      async (request, reply) => {
        if (
          (request.body.source !== undefined && request.body.source !== "manual") ||
          request.body.generationProvenance !== undefined
        )
          throw new ApiError(
            400,
            "DATASET_SOURCE_RESERVED",
            "导入或 AI 来源只能由平台生成并记录。",
          );
        return reply
          .code(201)
          .send(await requireService().createVersion(request.params.datasetId, request.body));
      },
    );

    app.get(
      "/v1/dataset-versions/:versionId/cases",
      {
        schema: {
          tags: ["datasets"],
          params: VersionParams,
          response: { 200: Type.Array(EvaluationCaseSchema) },
        },
      },
      async (request) => requireService().listCases(request.params.versionId),
    );

    app.post(
      "/v1/datasets/:datasetId/import-preview",
      {
        config: { rateLimit: { max: 20, timeWindow: 60_000 } },
        schema: {
          tags: ["datasets"],
          params: DatasetParams,
          body: DatasetImportPreviewRequestSchema,
          response: { 200: DatasetImportPreviewSchema },
        },
      },
      async (request) => {
        await requireService().listVersions(request.params.datasetId);
        return parseDatasetImport(request.body).preview;
      },
    );
    app.post(
      "/v1/datasets/:datasetId/import",
      {
        config: { rateLimit: { max: 10, timeWindow: 60_000 } },
        schema: {
          tags: ["datasets"],
          params: DatasetParams,
          body: DatasetImportRequestSchema,
          response: { 201: DatasetVersionSchema },
        },
      },
      async (request, reply) => {
        const service = requireService();
        await service.listVersions(request.params.datasetId);
        const { preview, cases } = parseDatasetImport(request.body);
        if (!preview.canImport)
          throw new ApiError(
            422,
            "DATASET_IMPORT_INVALID",
            "导入存在错误，请修正后重新预览。",
            preview,
          );
        if (preview.previewHash !== request.body.previewHash)
          throw new ApiError(
            409,
            "DATASET_IMPORT_PREVIEW_CHANGED",
            "文件内容或解析规则已变化，请重新预览。",
          );
        const version = await service.createVersion(request.params.datasetId, {
          source: "imported",
          cases,
          generationProvenance: {
            parser: DATASET_IMPORT_VERSION,
            format: request.body.format,
            sourceHash: preview.previewHash,
            rowCount: cases.length,
          },
          ...(request.body.parentVersionId
            ? { parentVersionId: request.body.parentVersionId }
            : {}),
          changeSummary: `导入 ${cases.length} 条 ${request.body.format.toUpperCase()} 用例（待审核草稿）`,
        });
        return reply.code(201).send(version);
      },
    );

    app.post(
      "/v1/datasets/:datasetId/generate",
      {
        config: { rateLimit: { max: 3, timeWindow: 60_000 } },
        schema: {
          tags: ["datasets"],
          params: DatasetParams,
          body: GenerateDatasetCasesRequestSchema,
          response: { 201: DatasetVersionSchema },
        },
      },
      async (request, reply) => {
        const datasetService = requireService();
        if (!generator)
          throw new ApiError(
            503,
            "DATASET_GENERATION_UNAVAILABLE",
            "AI 用例生成尚未配置，请联系管理员设置生成模型。",
          );
        await datasetService.listVersions(request.params.datasetId);
        const versionInput = await generator.generate(request.body);
        return reply
          .code(201)
          .send(await datasetService.createVersion(request.params.datasetId, versionInput));
      },
    );

    app.post(
      "/v1/dataset-versions/:versionId/publish",
      {
        schema: {
          tags: ["datasets"],
          params: VersionParams,
          response: { 200: DatasetVersionSchema },
        },
      },
      async (request) => requireService().publishVersion(request.params.versionId),
    );

    return Promise.resolve();
  };
}
