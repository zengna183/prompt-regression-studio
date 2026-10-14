import { UuidSchema } from "@ai-chat-eval/contracts";
import type { ModelConnectionMetadata } from "@ai-chat-eval/db";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { ModelConnectionService } from "../model-connection-service.js";

const Params = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });
const ConnectionParams = Type.Object(
  { projectId: UuidSchema, connectionId: UuidSchema },
  { additionalProperties: false },
);
const ConnectionSchema = Type.Object(
  {
    id: UuidSchema,
    projectId: UuidSchema,
    name: Type.String(),
    baseUrl: Type.String(),
    allowedModels: Type.Array(Type.String()),
    supportsSeed: Type.Boolean(),
    disabledAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const InputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    baseUrl: Type.String({ minLength: 8, maxLength: 2048 }),
    allowedModels: Type.Array(Type.String({ minLength: 1, maxLength: 240, pattern: "^[^\\s]+$" }), {
      minItems: 1,
      maxItems: 50,
    }),
    apiKey: Type.String({ minLength: 8, maxLength: 4096 }),
    supportsSeed: Type.Boolean({ default: true }),
  },
  { additionalProperties: false },
);
const TestResultSchema = Type.Object(
  { reachable: Type.Boolean(), code: Type.String() },
  { additionalProperties: false },
);

function dto(row: ModelConnectionMetadata) {
  return {
    ...row,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function modelConnectionRoutes(service: ModelConnectionService): FastifyPluginAsyncTypebox {
  return (app) => {
    app.get(
      "/v1/projects/:projectId/model-connections",
      {
        schema: {
          tags: ["model-connections"],
          params: Params,
          response: { 200: Type.Array(ConnectionSchema) },
        },
      },
      async (request) => (await service.list(request.params.projectId)).map(dto),
    );

    app.post(
      "/v1/projects/:projectId/model-connections",
      {
        schema: {
          tags: ["model-connections"],
          params: Params,
          body: InputSchema,
          response: { 201: ConnectionSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(dto(await service.create(request.params.projectId, request.body))),
    );

    app.post(
      "/v1/projects/:projectId/model-connections/:connectionId/rotate",
      {
        schema: {
          tags: ["model-connections"],
          params: ConnectionParams,
          body: Type.Object(
            { apiKey: Type.String({ minLength: 8, maxLength: 4096 }) },
            { additionalProperties: false },
          ),
          response: { 200: ConnectionSchema },
        },
      },
      async (request) =>
        dto(
          await service.rotate(
            request.params.projectId,
            request.params.connectionId,
            request.body.apiKey,
          ),
        ),
    );

    app.post(
      "/v1/projects/:projectId/model-connections/:connectionId/disable",
      {
        schema: {
          tags: ["model-connections"],
          params: ConnectionParams,
          response: { 200: ConnectionSchema },
        },
      },
      async (request) =>
        dto(await service.disable(request.params.projectId, request.params.connectionId)),
    );

    app.post(
      "/v1/projects/:projectId/model-connections/:connectionId/test",
      {
        config: { rateLimit: { max: 5, timeWindow: 60_000 } },
        schema: {
          tags: ["model-connections"],
          params: ConnectionParams,
          response: { 200: TestResultSchema },
        },
      },
      async (request) => service.test(request.params.projectId, request.params.connectionId),
    );
    return Promise.resolve();
  };
}
