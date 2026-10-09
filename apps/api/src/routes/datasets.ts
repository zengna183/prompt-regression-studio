import {
  CreateDatasetSchema,
  CreateDatasetVersionSchema,
  DatasetSchema,
  DatasetVersionSchema,
  EvaluationCaseSchema,
  UuidSchema,
} from "@ai-chat-eval/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { DatasetService } from "../dataset-service.js";
import { ApiError } from "../errors.js";

const ProjectParams = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });
const DatasetParams = Type.Object({ datasetId: UuidSchema }, { additionalProperties: false });
const VersionParams = Type.Object({ versionId: UuidSchema }, { additionalProperties: false });

export function datasetRoutes(service: DatasetService | undefined): FastifyPluginAsyncTypebox {
  return (app) => {
    function requireService(): DatasetService {
      if (!service) {
        throw new ApiError(503, "DATASETS_UNAVAILABLE", "Dataset management is not configured.");
      }
      return service;
    }

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
      async (request, reply) =>
        reply
          .code(201)
          .send(await requireService().createVersion(request.params.datasetId, request.body)),
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
