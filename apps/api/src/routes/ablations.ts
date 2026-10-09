import { AblationSchema, CreateAblationSchema, UuidSchema } from "@ai-chat-eval/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { AblationService } from "../ablation-service.js";
import { ApiError } from "../errors.js";

const Params = Type.Object(
  { projectId: UuidSchema, experimentId: UuidSchema },
  { additionalProperties: false },
);
const path = "/v1/projects/:projectId/experiments/:experimentId/ablations";

export function ablationRoutes(service: AblationService | undefined): FastifyPluginAsyncTypebox {
  return (app) => {
    app.get(
      path,
      {
        schema: {
          tags: ["ablations"],
          params: Params,
          response: { 200: Type.Array(AblationSchema) },
        },
      },
      async (request) => {
        if (!service)
          throw new ApiError(503, "ABLATIONS_UNAVAILABLE", "Ablation execution is not configured.");
        return service.list(request.params.projectId, request.params.experimentId);
      },
    );
    app.post(
      path,
      {
        config: { rateLimit: { max: 5, timeWindow: 60_000 } },
        schema: {
          tags: ["ablations"],
          summary:
            "Queue a real single-block revert and candidate replay using source settings (repetition 1)",
          params: Params,
          body: CreateAblationSchema,
          response: { 202: AblationSchema },
        },
      },
      async (request, reply) => {
        if (!service)
          throw new ApiError(503, "ABLATIONS_UNAVAILABLE", "Ablation execution is not configured.");
        const result = await service.create(
          request.params.projectId,
          request.params.experimentId,
          request.body,
        );
        return reply
          .header(
            "location",
            `/v1/projects/${request.params.projectId}/experiments/${result.experimentId}`,
          )
          .code(202)
          .send(result);
      },
    );
    return Promise.resolve();
  };
}
