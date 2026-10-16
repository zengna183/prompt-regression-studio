import {
  permitsProjectAction,
  type AccountIdentity,
  type IdentityRepository,
  type ProjectAccessRepository,
  type ProjectPermission,
  type ProjectResource,
} from "@ai-chat-eval/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";

export interface TeamAuth {
  identity: IdentityRepository;
  projects: ProjectAccessRepository;
  resolveProject: (resource: ProjectResource, id: string) => Promise<string | null>;
}
declare module "fastify" {
  interface FastifyRequest {
    account: AccountIdentity | null;
    authorizedProjectId: string | null;
  }
}
export function requireAccount(request: FastifyRequest): AccountIdentity {
  if (!request.account) throw new ApiError(401, "UNAUTHORIZED", "Please sign in.");
  return request.account;
}
const denied = () => new ApiError(404, "NOT_FOUND", "The requested resource was not found.");
const directRoutes: Record<string, [ProjectResource, string]> = {
  "/v1/prompts/:promptId/versions": ["prompt", "promptId"],
  "/v1/prompt-versions/:versionId/publish": ["promptVersion", "versionId"],
  "/v1/frameworks/:frameworkId/versions": ["framework", "frameworkId"],
  "/v1/framework-versions/:versionId/publish": ["frameworkVersion", "versionId"],
  "/v1/datasets/:datasetId/versions": ["dataset", "datasetId"],
  "/v1/datasets/:datasetId/import-preview": ["dataset", "datasetId"],
  "/v1/datasets/:datasetId/import": ["dataset", "datasetId"],
  "/v1/datasets/:datasetId/generate": ["dataset", "datasetId"],
  "/v1/dataset-versions/:versionId/cases": ["datasetVersion", "versionId"],
  "/v1/dataset-versions/:versionId/review": ["datasetVersion", "versionId"],
  "/v1/dataset-versions/:versionId/publish": ["datasetVersion", "versionId"],
  "/v1/evaluation-runs/:evaluationRunId/dispatch": ["evaluationRun", "evaluationRunId"],
  "/v1/diagnoses/:id": ["diagnosis", "id"],
};
const projectSuffixes = new Set([
  "prompts",
  "frameworks",
  "datasets",
  "experiments",
  "experiments/:experimentId",
  "experiments/:experimentId/comparison",
  "experiments/:experimentId/start",
  "experiments/:experimentId/cancel",
  "experiments/:experimentId/diagnoses",
  "experiments/:experimentId/ablations",
  "model-connections",
  "model-connections/:connectionId/rotate",
  "model-connections/:connectionId/disable",
  "model-connections/:connectionId/test",
  "members",
  "access",
]);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function installTeamAuth(app: FastifyInstance, team: TeamAuth) {
  app.decorateRequest("account", null);
  app.decorateRequest("authorizedProjectId", null);
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.url;
    if (request.method === "OPTIONS" || !route?.startsWith("/v1/")) return;
    if (route === "/v1/auth/status" || route === "/v1/auth/login") return;
    const token = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    const account = token ? await team.identity.resolveSession(token) : null;
    if (!account) throw new ApiError(401, "UNAUTHORIZED", "Please sign in.");
    request.account = account;
  });
  app.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url;
    if (request.method === "OPTIONS" || !route?.startsWith("/v1/")) return;
    if (route === "/v1/auth/status" || route === "/v1/auth/login") return;
    const user = requireAccount(request);
    if (
      [
        "/v1/auth/me",
        "/v1/auth/logout",
        "/v1/auth/password",
        "/v1/projects",
        "/v1/datasets/generation-availability",
      ].includes(route)
    )
      return;
    if (route === "/v1/auth/users" || route === "/v1/auth/users/:userId/disable") {
      if (!user.isAdmin) throw new ApiError(403, "FORBIDDEN", "Administrator access is required.");
      return;
    }
    const params = record(request.params);
    let projectId: string | null = null;
    const prefix = "/v1/projects/:projectId/";
    if (route.startsWith(prefix) && projectSuffixes.has(route.slice(prefix.length))) {
      projectId = typeof params.projectId === "string" ? params.projectId : null;
    } else if (directRoutes[route]) {
      const [kind, param] = directRoutes[route];
      projectId =
        typeof params[param] === "string" ? await team.resolveProject(kind, params[param]) : null;
    } else if (route === "/v1/diagnoses") {
      const query = record(request.query);
      projectId = typeof query.projectId === "string" ? query.projectId : null;
    }
    // New or forgotten routes are denied by default, never silently treated as project-wide reads.
    if (!projectId) throw denied();
    const role = await team.projects.roleFor(user.id, projectId);
    if (!role) throw denied();
    let permission: ProjectPermission =
      request.method === "GET" || request.method === "HEAD" ? "read" : "write";
    if (permission !== "read" && route.includes("model-connections")) permission = "manage_models";
    if (permission !== "read" && route.endsWith("/members")) permission = "manage_members";
    if (permission !== "read" && /\/(start|generate|dispatch|ablations)$/.test(route))
      permission = "run";
    if (!permitsProjectAction(role, permission))
      throw new ApiError(403, "FORBIDDEN", "Your project role does not permit this action.");
    request.authorizedProjectId = projectId;
    for (const [parameter, kind] of [
      ["experimentId", "experiment"],
      ["connectionId", "modelConnection"],
    ] as const) {
      if (
        typeof params[parameter] === "string" &&
        (await team.resolveProject(kind, params[parameter])) !== projectId
      )
        throw denied();
    }
    const body = record(request.body);
    const references: [ProjectResource, unknown][] = [
      ["datasetVersion", body.datasetVersionId],
      ["frameworkVersion", body.frameworkVersionId],
      ["promptVersion", body.candidatePromptVersionId],
      ["modelConnection", body.modelConnectionId],
      ["modelConnection", body.evaluatorConnectionId],
    ];
    if (Array.isArray(body.promptVersions))
      for (const item of body.promptVersions)
        references.push(["promptVersion", record(item).promptVersionId]);
    if (body.parentVersionId !== undefined) {
      const kind = route.includes("/prompts/")
        ? "promptVersion"
        : route.includes("/frameworks/")
          ? "frameworkVersion"
          : "datasetVersion";
      references.push([kind, body.parentVersionId]);
    }
    for (const [kind, id] of references)
      if (
        id !== undefined &&
        (typeof id !== "string" || (await team.resolveProject(kind, id)) !== projectId)
      )
        throw denied();
    // Clients cannot impersonate another reviewer or author by supplying their name.
    if (route.endsWith("/review"))
      body.reviewerName = `${user.displayName.slice(0, 80)} (${user.id})`;
    if ("createdBy" in body) body.createdBy = user.id;
  });
}
