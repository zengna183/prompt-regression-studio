import {
    CreateExperimentSchema,
    ExperimentDetailSchema,
    ExperimentSchema,
  StartExperimentSchema,
  StartedExperimentSchema,
  UuidSchema,
} from "@ai-chat-eval/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { ApiError } from "../errors.js";
import type { ExperimentService } from "../experiment-service.js";

const ProjectParams = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });
const ExperimentParams = Type.Object(
  { projectId: UuidSchema, experimentId: UuidSchema },
  { additionalProperties: false },
);

export function experimentRoutes(service: ExperimentService | undefined): FastifyPluginAsyncTypebox {
  return (app) => {
    app.get(
      "/v1/projects/:projectId/experiments",
      {
        schema: {
          tags: ["experiments"],
          params: ProjectParams,
          response: { 200: Type.Array(ExperimentSchema) },
        },
      },
      async (request) => {
        if (!service) {
          throw new ApiError(503, "EXPERIMENTS_UNAVAILABLE", "Experiment queries are not configured.");
        }
        return service.list(request.params.projectId);
      },
    );
    app.get(
      "/v1/projects/:projectId/experiments/:experimentId",
      {
        schema: {
          tags: ["experiments"],
          params: ExperimentParams,
          response: { 200: ExperimentDetailSchema },
        },
      },
      async (request) => {
        if (!service) {
          throw new ApiError(503, "EXPERIMENTS_UNAVAILABLE", "Experiment queries are not configured.");
        }
        return service.get(request.params.projectId, request.params.experimentId);
      },
    );
    app.post(
      "/v1/projects/:projectId/experiments",
      {
        schema: {
          tags: ["experiments"],
          summary: "Create a reproducible Prompt comparison plan",
          params: ProjectParams,
          body: CreateExperimentSchema,
          response: { 201: ExperimentSchema },
        },
      },
      async (request, reply) => {
        if (!service) {
          throw new ApiError(503, "EXPERIMENTS_UNAVAILABLE", "Experiment creation is not configured.");
        }
        return reply.code(201).send(await service.create(request.params.projectId, request.body));
      },
    );
    app.post(
      "/v1/projects/:projectId/experiments/:experimentId/start",
      {
        config: { rateLimit: { max: 10, timeWindow: 60_000 } },
        schema: {
          tags: ["experiments"],
          summary: "Start a saved experiment and queue its evaluation runs",
          params: ExperimentParams,
          body: StartExperimentSchema,
          response: { 202: StartedExperimentSchema },
        },
      },
      async (request, reply) => {
        if (!service) {
          throw new ApiError(503, "EXPERIMENTS_UNAVAILABLE", "Experiment execution is not configured.");
        }
        const { projectId, experimentId } = request.params;
        return reply.code(202).send(await service.start(projectId, experimentId, request.body));
      },
    );
    return Promise.resolve();
  };
}
