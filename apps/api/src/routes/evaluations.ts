import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { ApiError } from "../errors.js";
import type { EvaluationDispatcher } from "../evaluation-dispatcher.js";

const EvaluationRunParams = Type.Object(
  { evaluationRunId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const AcceptedResponse = Type.Object(
  { evaluationRunId: Type.String({ format: "uuid" }), status: Type.Literal("queued") },
  { additionalProperties: false },
);

export function evaluationRoutes(
  dispatcher: EvaluationDispatcher | undefined,
): FastifyPluginAsyncTypebox {
  return (app) => {
    app.post(
      "/v1/evaluation-runs/:evaluationRunId/dispatch",
      {
        config: { rateLimit: { max: 30, timeWindow: 60_000 } },
        schema: {
          tags: ["evaluations"],
          summary: "Queue an existing evaluation run for background execution",
          params: EvaluationRunParams,
          response: { 202: AcceptedResponse },
        },
      },
      async (request, reply) => {
        if (!dispatcher) {
          throw new ApiError(
            503,
            "EVALUATION_DISPATCH_UNAVAILABLE",
            "Evaluation dispatch is not configured.",
          );
        }
        await dispatcher.dispatch(request.params.evaluationRunId);
        void reply.header(
          "location",
          `/v1/evaluation-runs/${encodeURIComponent(request.params.evaluationRunId)}`,
        );
        return reply.code(202).send({ evaluationRunId: request.params.evaluationRunId, status: "queued" });
      },
    );
    return Promise.resolve();
  };
}
