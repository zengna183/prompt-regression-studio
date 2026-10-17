import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  createIdentityRepository,
  createProjectAccessRepository,
  createResourceProjectResolver,
  loadDatabaseConfig,
  type DatabaseClient,
} from "@ai-chat-eval/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabaseCatalog } from "./database-catalog.js";
import { createDatabaseDatasetService } from "./database-dataset-service.js";

// The db package migrates CI's disposable TEST_DATABASE_URL before API tests run.
// All fixtures, sessions and audit events are rolled back; DATABASE_URL is never consulted.
describe.skipIf(!process.env.TEST_DATABASE_URL)("team HTTP authorization with PostgreSQL", () => {
  let client: DatabaseClient;
  beforeAll(() => {
    client = createDatabaseClient(
      loadDatabaseConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
  });
  afterAll(async () => {
    await client?.close();
  });
  it("enforces real sessions, private resource ownership, role changes and verified reviewers end to end", async () => {
    const rollback = new Error("rollback team authorization fixture");
    try {
      await client.db.transaction(async (tx) => {
        const identity = createIdentityRepository(tx);
        const access = createProjectAccessRepository(tx);
        const password = "test-only team integration password";
        const admin = await identity.bootstrap({
          email: `admin-${randomUUID()}@example.test`,
          displayName: "Administrator",
          password,
        });
        const owner = await identity.createUser(admin.id, {
          email: `owner-${randomUUID()}@example.test`,
          displayName: "Owner",
          password,
        });
        const member = await identity.createUser(admin.id, {
          email: `member-${randomUUID()}@example.test`,
          displayName: "Verified reviewer",
          password,
        });
        const app = await buildApp({
          catalog: createDatabaseCatalog(tx),
          datasetService: createDatabaseDatasetService(tx),
          teamAuth: {
            identity,
            projects: access,
            resolveProject: createResourceProjectResolver(tx),
          },
          diagnosisEngine: {
            diagnose: () => Promise.reject(new Error("Not used by authorization tests")),
          },
          maxConcurrentDiagnoses: 1,
          docsEnabled: false,
          rateLimitMax: 1000,
        });
        try {
          async function login(email: string, value = password) {
            const result = await app.inject({
              method: "POST",
              url: "/v1/auth/login",
              payload: { email, password: value },
            });
            expect(result.statusCode).toBe(200);
            const body = result.json<{ token: string }>();
            return { authorization: `Bearer ${body.token}` };
          }
          const adminHeaders = await login(admin.email);
          const ownerHeaders = await login(owner.email);
          const memberHeaders = await login(member.email);
          const ownedResponse = await app.inject({
            method: "POST",
            url: "/v1/projects",
            headers: ownerHeaders,
            payload: { slug: `team-${randomUUID()}`, name: "Private team" },
          });
          expect(ownedResponse.statusCode).toBe(201);
          const owned = ownedResponse.json<{ id: string }>();
          const foreign = await access.createProject(admin.id, {
            slug: `foreign-${randomUUID()}`,
            name: "Other project",
          });
          expect(
            (await app.inject({ url: `/v1/projects/${owned.id}/prompts`, headers: adminHeaders }))
              .statusCode,
          ).toBe(404);
          expect(
            (await app.inject({ url: `/v1/projects/${foreign.id}/prompts`, headers: ownerHeaders }))
              .statusCode,
          ).toBe(404);
          expect(
            (await app.inject({ url: "/v1/projects", headers: memberHeaders })).json(),
          ).toEqual([]);
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/v1/projects/${owned.id}/members`,
                headers: ownerHeaders,
                payload: { email: member.email.toUpperCase(), role: "viewer" },
              })
            ).statusCode,
          ).toBe(200);
          expect(
            (await app.inject({ url: "/v1/projects", headers: memberHeaders })).json(),
          ).toMatchObject([{ id: owned.id }]);
          const prompts = createDatabaseCatalog(tx);
          const ownPrompt = await prompts.createPrompt(owned.id, {
            key: "own",
            name: "Own prompt",
          });
          const foreignPrompt = await prompts.createPrompt(foreign.id, {
            key: "other",
            name: "Other prompt",
          });
          const blocks = [
            { id: "role", kind: "role" as const, name: "Role", content: "Be accurate" },
          ];
          const foreignVersion = await prompts.createPromptVersion(foreignPrompt.id, { blocks });
          expect(
            (
              await app.inject({
                url: `/v1/prompts/${ownPrompt.id}/versions`,
                headers: memberHeaders,
              })
            ).statusCode,
          ).toBe(200);
          expect(
            (
              await app.inject({
                url: `/v1/prompts/${foreignPrompt.id}/versions`,
                headers: memberHeaders,
              })
            ).statusCode,
          ).toBe(404);
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/v1/prompts/${ownPrompt.id}/versions`,
                headers: ownerHeaders,
                payload: { blocks, parentVersionId: foreignVersion.id },
              })
            ).statusCode,
          ).toBe(404);
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/v1/projects/${owned.id}/prompts`,
                headers: memberHeaders,
                payload: { key: "denied", name: "Denied creation" },
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/v1/projects/${owned.id}/members`,
                headers: memberHeaders,
                payload: { userId: member.id, role: "owner" },
              })
            ).statusCode,
          ).toBe(403);
          const datasets = createDatabaseDatasetService(tx);
          const dataset = await datasets.create(owned.id, { key: "cases", name: "Review cases" });
          const cases = [{ caseKey: "one", input: "Hello", expectedOutput: "Hello", metadata: {} }];
          const version = await datasets.createVersion(dataset.id, { cases });
          const reviewRequest = {
            method: "POST" as const,
            url: `/v1/dataset-versions/${version.id}/review`,
            headers: memberHeaders,
            payload: { reviewerName: "Spoofed reviewer", acknowledged: true, cases },
          };
          expect((await app.inject(reviewRequest)).statusCode).toBe(403);
          await access.setMember(owner.id, owned.id, member.id, "editor");
          const reviewed = await app.inject(reviewRequest);
          expect(reviewed.statusCode).toBe(200);
          expect(reviewed.json()).toMatchObject({
            reviewedBy: `${member.displayName} (${member.id})`,
          });
          const nextPassword = "changed test-only team password";
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/v1/auth/password",
                headers: memberHeaders,
                payload: { currentPassword: password, nextPassword },
              })
            ).statusCode,
          ).toBe(200);
          expect(
            (await app.inject({ url: "/v1/projects", headers: memberHeaders })).statusCode,
          ).toBe(401);
          const fresh = await login(member.email, nextPassword);
          await access.setMember(owner.id, owned.id, member.id, null);
          expect(
            (await app.inject({ url: `/v1/prompts/${ownPrompt.id}/versions`, headers: fresh }))
              .statusCode,
          ).toBe(404);
          expect((await app.inject({ url: "/v1/projects", headers: fresh })).json()).toEqual([]);
          expect(
            (await app.inject({ method: "POST", url: "/v1/auth/logout", headers: ownerHeaders }))
              .statusCode,
          ).toBe(200);
          expect(
            (await app.inject({ url: "/v1/projects", headers: ownerHeaders })).statusCode,
          ).toBe(401);
        } finally {
          await app.close();
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 45_000);
});
