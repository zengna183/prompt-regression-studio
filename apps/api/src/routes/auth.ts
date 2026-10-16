import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { UuidSchema } from "@ai-chat-eval/contracts";
import { ApiError } from "../errors.js";
import { requireAccount, type TeamAuth } from "../team-auth.js";

const User = Type.Object(
  { id: UuidSchema, email: Type.String(), displayName: Type.String(), isAdmin: Type.Boolean() },
  { additionalProperties: false },
);
const Password = Type.String({ minLength: 15, maxLength: 128 });
const MemberRole = Type.Union([
  Type.Literal("owner"),
  Type.Literal("editor"),
  Type.Literal("viewer"),
]);
const ProjectParams = Type.Object({ projectId: UuidSchema }, { additionalProperties: false });
const rateLimit = { max: 5, timeWindow: 60_000 };

async function inputOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TypeError)
      throw new ApiError(
        422,
        "INVALID_ACCOUNT_INPUT",
        "请检查邮箱、姓名及密码长度（15～128 个字符）。",
      );
    throw error;
  }
}
export function authRoutes(team: TeamAuth): FastifyPluginAsyncTypebox {
  return (app) => {
    app.post(
      "/v1/auth/login",
      {
        config: { rateLimit },
        schema: {
          body: Type.Object(
            { email: Type.String({ maxLength: 254 }), password: Type.String({ maxLength: 128 }) },
            { additionalProperties: false },
          ),
          response: {
            200: Type.Object(
              { user: User, token: Type.String(), expiresAt: Type.String() },
              { additionalProperties: false },
            ),
          },
        },
      },
      async (request) => {
        const login = await team.identity.login(request.body.email, request.body.password);
        if (!login)
          throw new ApiError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确，或账号已停用。");
        return { ...login, expiresAt: login.expiresAt.toISOString() };
      },
    );
    app.get("/v1/auth/me", { schema: { response: { 200: User } } }, (request) =>
      requireAccount(request),
    );
    app.post("/v1/auth/logout", async (request) => {
      const token = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
      if (token) await team.identity.logout(token);
      return { ok: true };
    });
    app.post(
      "/v1/auth/password",
      {
        config: { rateLimit },
        schema: {
          body: Type.Object(
            { currentPassword: Type.String({ maxLength: 128 }), nextPassword: Password },
            { additionalProperties: false },
          ),
        },
      },
      async (request) => {
        const changed = await inputOperation(() =>
          team.identity.changePassword(
            requireAccount(request).id,
            request.body.currentPassword,
            request.body.nextPassword,
          ),
        );
        if (!changed)
          throw new ApiError(401, "INVALID_CREDENTIALS", "当前密码不正确或会话已失效。");
        return { ok: true };
      },
    );
    app.get("/v1/auth/users", async (request) =>
      team.identity.listUsers(requireAccount(request).id),
    );
    app.post(
      "/v1/auth/users",
      {
        config: { rateLimit },
        schema: {
          body: Type.Object(
            {
              email: Type.String({ maxLength: 254 }),
              displayName: Type.String({ minLength: 1, maxLength: 120 }),
              password: Password,
            },
            { additionalProperties: false },
          ),
          response: { 201: User },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            await inputOperation(() =>
              team.identity.createUser(requireAccount(request).id, request.body),
            ),
          ),
    );
    app.post(
      "/v1/auth/users/:userId/disable",
      { schema: { params: Type.Object({ userId: UuidSchema }, { additionalProperties: false }) } },
      async (request) => {
        await team.identity.disableUser(requireAccount(request).id, request.params.userId);
        return { ok: true };
      },
    );
    app.get(
      "/v1/projects/:projectId/access",
      { schema: { params: ProjectParams } },
      async (request) => ({
        role: await team.projects.roleFor(requireAccount(request).id, request.params.projectId),
      }),
    );
    app.get(
      "/v1/projects/:projectId/members",
      { schema: { params: ProjectParams } },
      async (request) =>
        team.projects.listMembers(requireAccount(request).id, request.params.projectId),
    );
    app.post(
      "/v1/projects/:projectId/members",
      {
        schema: {
          params: ProjectParams,
          body: Type.Object(
            { userId: UuidSchema, role: Type.Union([MemberRole, Type.Null()]) },
            { additionalProperties: false },
          ),
        },
      },
      async (request) => {
        await team.projects.setMember(
          requireAccount(request).id,
          request.params.projectId,
          request.body.userId,
          request.body.role,
        );
        return { ok: true };
      },
    );
    return Promise.resolve();
  };
}
