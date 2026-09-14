import {
  CreateFrameworkSchema,
  CreateFrameworkVersionSchema,
  CreateProjectSchema,
  CreatePromptSchema,
  CreatePromptVersionSchema,
  EvaluationFrameworkSchema,
  FrameworkVersionSchema,
  ProjectSchema,
  PromptSchema,
  PromptVersionSchema,
  UuidSchema,
} from "@ai-chat-eval/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { CatalogService } from "../catalog-service.js";

const ProjectParams = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });
const PromptParams = Type.Object({ promptId: UuidSchema }, { additionalProperties: false });
const PromptVersionParams = Type.Object({ versionId: UuidSchema }, { additionalProperties: false });
const FrameworkParams = Type.Object({ frameworkId: UuidSchema }, { additionalProperties: false });
const FrameworkVersionParams = Type.Object(
  { versionId: UuidSchema },
  { additionalProperties: false },
);

export function catalogRoutes(catalog: CatalogService): FastifyPluginAsyncTypebox {
  return (app) => {
    app.get(
      "/v1/projects",
      { schema: { tags: ["projects"], response: { 200: Type.Array(ProjectSchema) } } },
      async () => catalog.listProjects(),
    );

    app.post(
      "/v1/projects",
      {
        schema: {
          tags: ["projects"],
          body: CreateProjectSchema,
          response: { 201: ProjectSchema },
        },
      },
      async (request, reply) => reply.code(201).send(await catalog.createProject(request.body)),
    );

    app.get(
      "/v1/projects/:projectId/prompts",
      {
        schema: {
          tags: ["prompts"],
          params: ProjectParams,
          response: { 200: Type.Array(PromptSchema) },
        },
      },
      async (request) => catalog.listPrompts(request.params.projectId),
    );

    app.post(
      "/v1/projects/:projectId/prompts",
      {
        schema: {
          tags: ["prompts"],
          params: ProjectParams,
          body: CreatePromptSchema,
          response: { 201: PromptSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await catalog.createPrompt(request.params.projectId, request.body)),
    );

    app.get(
      "/v1/prompts/:promptId/versions",
      {
        schema: {
          tags: ["prompts"],
          params: PromptParams,
          response: { 200: Type.Array(PromptVersionSchema) },
        },
      },
      async (request) => catalog.listPromptVersions(request.params.promptId),
    );

    app.post(
      "/v1/prompts/:promptId/versions",
      {
        schema: {
          tags: ["prompts"],
          params: PromptParams,
          body: CreatePromptVersionSchema,
          response: { 201: PromptVersionSchema },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(await catalog.createPromptVersion(request.params.promptId, request.body)),
    );

    app.post(
      "/v1/prompt-versions/:versionId/publish",
      {
        schema: {
          tags: ["prompts"],
          params: PromptVersionParams,
          response: { 200: PromptVersionSchema },
        },
      },
      async (request) => catalog.publishPromptVersion(request.params.versionId),
    );

    app.get(
      "/v1/projects/:projectId/frameworks",
      {
        schema: {
          tags: ["frameworks"],
          params: ProjectParams,
          response: { 200: Type.Array(EvaluationFrameworkSchema) },
        },
      },
      async (request) => catalog.listFrameworks(request.params.projectId),
    );

    app.post(
      "/v1/projects/:projectId/frameworks",
      {
        schema: {
          tags: ["frameworks"],
          params: ProjectParams,
          body: CreateFrameworkSchema,
          response: { 201: EvaluationFrameworkSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await catalog.createFramework(request.params.projectId, request.body)),
    );

    app.get(
      "/v1/frameworks/:frameworkId/versions",
      {
        schema: {
          tags: ["frameworks"],
          params: FrameworkParams,
          response: { 200: Type.Array(FrameworkVersionSchema) },
        },
      },
      async (request) => catalog.listFrameworkVersions(request.params.frameworkId),
    );

    app.post(
      "/v1/frameworks/:frameworkId/versions",
      {
        schema: {
          tags: ["frameworks"],
          params: FrameworkParams,
          body: CreateFrameworkVersionSchema,
          response: { 201: FrameworkVersionSchema },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(await catalog.createFrameworkVersion(request.params.frameworkId, request.body)),
    );

    app.post(
      "/v1/framework-versions/:versionId/publish",
      {
        schema: {
          tags: ["frameworks"],
          params: FrameworkVersionParams,
          response: { 200: FrameworkVersionSchema },
        },
      },
      async (request) => catalog.publishFrameworkVersion(request.params.versionId),
    );

    return Promise.resolve();
  };
}
