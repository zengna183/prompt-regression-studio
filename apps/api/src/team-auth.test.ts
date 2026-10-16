/* eslint @typescript-eslint/unbound-method: "off" -- These assertions inspect mock methods, not unbound invocations. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AccountIdentity,
  IdentityRepository,
  ProjectAccessRepository,
  ProjectRole,
} from "@ai-chat-eval/db";
import { buildApp } from "./app.js";
import type { CatalogService } from "./catalog-service.js";
import type { DatasetService } from "./dataset-service.js";
import type { TeamAuth } from "./team-auth.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(role: ProjectRole = "owner", isAdmin = false) {
  const projectId = randomUUID();
  const foreignProjectId = randomUUID();
  const user: AccountIdentity = {
    id: randomUUID(),
    email: "member@example.test",
    displayName: "真实审核员",
    isAdmin,
  };
  const identity: IdentityRepository = {
    bootstrap: vi.fn<IdentityRepository["bootstrap"]>(),
    createUser: vi.fn<IdentityRepository["createUser"]>(),
    listUsers: vi
      .fn<IdentityRepository["listUsers"]>()
      .mockResolvedValue([{ ...user, disabledAt: null }]),
    login: vi
      .fn<IdentityRepository["login"]>()
      .mockResolvedValue({ user, token: "session-token", expiresAt: new Date("2027-01-01") }),
    resolveSession: vi
      .fn<IdentityRepository["resolveSession"]>()
      .mockImplementation((token) => Promise.resolve(token === "session-token" ? user : null)),
    logout: vi.fn<IdentityRepository["logout"]>().mockResolvedValue(undefined),
    changePassword: vi.fn<IdentityRepository["changePassword"]>().mockResolvedValue(true),
    disableUser: vi.fn<IdentityRepository["disableUser"]>().mockResolvedValue(undefined),
    sessionLifetimeHours: 12,
  };
  const now = new Date();
  const project = {
    id: projectId,
    slug: "private",
    name: "Private project",
    description: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const projects: ProjectAccessRepository = {
    roleFor: vi
      .fn<ProjectAccessRepository["roleFor"]>()
      .mockImplementation((_user, id) => Promise.resolve(id === projectId ? role : null)),
    listProjects: vi
      .fn<ProjectAccessRepository["listProjects"]>()
      .mockResolvedValue([{ project, role }]),
    createProject: vi.fn<ProjectAccessRepository["createProject"]>().mockResolvedValue(project),
    listMembers: vi.fn<ProjectAccessRepository["listMembers"]>().mockResolvedValue([]),
    setMember: vi.fn<ProjectAccessRepository["setMember"]>().mockResolvedValue(undefined),
  };
  const resources = new Map<string, string>();
  const ownResource = randomUUID();
  const foreignResource = randomUUID();
  resources.set(ownResource, projectId);
  resources.set(foreignResource, foreignProjectId);
  const team: TeamAuth = {
    identity,
    projects,
    resolveProject: vi
      .fn<TeamAuth["resolveProject"]>()
      .mockImplementation((_kind, id) => Promise.resolve(resources.get(id) ?? null)),
  };
  const catalog: CatalogService = {
    listProjects: vi.fn<CatalogService["listProjects"]>().mockResolvedValue([]),
    createProject: vi.fn<CatalogService["createProject"]>(),
    listPrompts: vi.fn<CatalogService["listPrompts"]>().mockResolvedValue([]),
    createPrompt: vi.fn<CatalogService["createPrompt"]>(),
    listPromptVersions: vi.fn<CatalogService["listPromptVersions"]>().mockResolvedValue([]),
    createPromptVersion: vi.fn<CatalogService["createPromptVersion"]>(),
    publishPromptVersion: vi.fn<CatalogService["publishPromptVersion"]>(),
    listFrameworks: vi.fn<CatalogService["listFrameworks"]>().mockResolvedValue([]),
    createFramework: vi.fn<CatalogService["createFramework"]>(),
    listFrameworkVersions: vi.fn<CatalogService["listFrameworkVersions"]>().mockResolvedValue([]),
    createFrameworkVersion: vi.fn<CatalogService["createFrameworkVersion"]>(),
    publishFrameworkVersion: vi.fn<CatalogService["publishFrameworkVersion"]>(),
  };
  const review = vi
    .fn<DatasetService["reviewVersion"]>()
    .mockRejectedValue(new Error("test handler reached"));
  const app = await buildApp({
    catalog,
    teamAuth: team,
    authToken: "a".repeat(32),
    diagnosisEngine: { diagnose: () => Promise.resolve({ report_id: "test" }) },
    maxConcurrentDiagnoses: 1,
    docsEnabled: false,
    rateLimitMax: 1000,
    datasetService: { reviewVersion: review } as unknown as DatasetService,
  });
  apps.push(app);
  return {
    app,
    team,
    catalog,
    projectId,
    foreignProjectId,
    ownResource,
    foreignResource,
    user,
    review,
    headers: { authorization: "Bearer session-token" },
  };
}

describe("team API authorization", () => {
  it("supports public mode discovery/login but not the legacy administrator token", async () => {
    const { app } = await fixture();
    expect((await app.inject({ url: "/v1/auth/status" })).json()).toEqual({ mode: "team" });
    expect((await app.inject({ url: "/v1/projects" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/v1/projects",
          headers: { authorization: `Bearer ${"a".repeat(32)}` },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "member@example.test", password: "long test-only password" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toBe("no-store");
    expect(login.body).not.toContain("passwordHash");
  });
  it("scopes project list and creation to the authenticated user", async () => {
    const { app, team, headers, user, catalog } = await fixture();
    expect((await app.inject({ url: "/v1/projects", headers })).statusCode).toBe(200);
    expect(team.projects.listProjects).toHaveBeenCalledWith(user.id);
    expect(catalog.listProjects).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/projects",
          headers,
          payload: { name: "New project", slug: "new-project" },
        })
      ).statusCode,
    ).toBe(201);
    expect(team.projects.createProject).toHaveBeenCalledWith(user.id, {
      name: "New project",
      slug: "new-project",
    });
    expect(catalog.createProject).not.toHaveBeenCalled();
  });
  it("denies a project's URL even for a platform administrator without membership", async () => {
    const { app, foreignProjectId, headers, catalog } = await fixture("owner", true);
    expect(
      (await app.inject({ url: `/v1/projects/${foreignProjectId}/prompts`, headers })).statusCode,
    ).toBe(404);
    expect(catalog.listPrompts).not.toHaveBeenCalled();
  });
  it("resolves indirect resource URLs before allowing reads or publication", async () => {
    const { app, foreignResource, ownResource, headers, catalog } = await fixture();
    for (const path of [
      `/v1/prompts/${foreignResource}/versions`,
      `/v1/frameworks/${foreignResource}/versions`,
      `/v1/dataset-versions/${foreignResource}/cases`,
    ])
      expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/prompt-versions/${foreignResource}/publish`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/v1/prompts/${ownResource}/versions`, headers })).statusCode,
    ).toBe(200);
    expect(catalog.publishPromptVersion).not.toHaveBeenCalled();
  });
  it("denies viewer writes, paid generation, and dispatch before executing a service", async () => {
    const { app, projectId, ownResource, headers } = await fixture("viewer");
    expect(
      (await app.inject({ url: `/v1/projects/${projectId}/prompts`, headers })).statusCode,
    ).toBe(200);
    const requests = [
      { url: `/v1/projects/${projectId}/prompts`, payload: { name: "Unauthorized", key: "nope" } },
      { url: `/v1/prompt-versions/${ownResource}/publish` },
      { url: `/v1/evaluation-runs/${ownResource}/dispatch` },
    ];
    for (const request of requests)
      expect((await app.inject({ method: "POST", ...request, headers })).statusCode).toBe(403);
  });
  it("an editor cannot alter membership or administer platform accounts", async () => {
    const { app, projectId, user, headers, team } = await fixture("editor");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/projects/${projectId}/members`,
          headers,
          payload: { userId: user.id, role: "owner" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: "/v1/auth/users", headers })).statusCode).toBe(403);
    expect(team.projects.setMember).not.toHaveBeenCalled();
  });
  it("rejects nested resource IDs from a different project, not just the project URL", async () => {
    const { app, projectId, foreignResource, ownResource, headers } = await fixture();
    expect(
      (
        await app.inject({
          url: `/v1/projects/${projectId}/experiments/${foreignResource}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const input = {
      name: "Cross-project test",
      randomSeed: 42,
      repetitions: 1,
      datasetVersionId: ownResource,
      frameworkVersionId: ownResource,
      promptVersions: [{ promptVersionId: ownResource, label: "Baseline", isBaseline: true }],
    };
    for (const payload of [
      { ...input, datasetVersionId: foreignResource },
      { ...input, frameworkVersionId: foreignResource },
      {
        ...input,
        promptVersions: [{ promptVersionId: foreignResource, label: "Foreign", isBaseline: true }],
      },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/projects/${projectId}/experiments`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/projects/${projectId}/experiments/${ownResource}/start`,
          headers,
          payload: {
            provider: "openai-compatible",
            model: "model-a",
            modelConnectionId: foreignResource,
          },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("denies forgotten future routes and unscoped external diagnosis uploads", async () => {
    const { app, headers } = await fixture();
    const leaked = vi.fn(() => ({ secret: "private" }));
    app.get("/v1/future-private-endpoint", leaked);
    expect((await app.inject({ url: "/v1/future-private-endpoint", headers })).statusCode).toBe(
      404,
    );
    expect(leaked).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/diagnoses",
          headers,
          payload: { schema_version: "prompt-regression.bundle/v1alpha1", bundle_id: "test" },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("replaces a forged review name with the authenticated identity", async () => {
    const { app, headers, ownResource, user, review } = await fixture();
    await app.inject({
      method: "POST",
      url: `/v1/dataset-versions/${ownResource}/review`,
      headers,
      payload: {
        reviewerName: "Another administrator",
        acknowledged: true,
        cases: [{ caseKey: "case-1", input: "hello" }],
      },
    });
    expect(review).toHaveBeenCalledWith(
      ownResource,
      expect.objectContaining({ reviewerName: `${user.displayName} (${user.id})` }),
    );
  });
  it("rate limits repeated login requests", async () => {
    const { app, team } = await fixture();
    vi.mocked(team.identity.login).mockResolvedValue(null);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/login",
            payload: { email: "a@example.test", password: "wrong" },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/login",
          payload: { email: "a@example.test", password: "wrong" },
        })
      ).statusCode,
    ).toBe(429);
  });
});
