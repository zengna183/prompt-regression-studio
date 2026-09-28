import { CreateExperimentSchema, ExperimentSchema, UuidSchema } from "@ai-chat-eval/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { ApiError } from "../errors.js";
import type { ExperimentService } from "../experiment-service.js";

const ProjectParams = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });

export function experimentRoutes(service: ExperimentService | undefined): FastifyPluginAsyncTypebox {
  return (app) => {
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
    return Promise.resolve();
  };
}
