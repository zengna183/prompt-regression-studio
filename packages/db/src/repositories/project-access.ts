import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { RepositoryDatabase } from "../client.js";
import { RepositoryConflictError } from "../errors.js";
import { auditEvents, projectMembers, projects, users } from "../schema.js";
import { normalizeDescription, normalizeKey, normalizeName } from "./common.js";
import { IdentityAccessError, lockIdentityMutation } from "./identity.js";
import { normalizeAccountEmail } from "../passwords.js";
import type { CreateProjectInput } from "./projects.js";

export type ProjectRole = "owner" | "editor" | "viewer";
export type ProjectPermission = "read" | "write" | "run" | "manage_members" | "manage_models";
const permissions: Record<ProjectPermission, readonly ProjectRole[]> = {
  read: ["owner", "editor", "viewer"],
  write: ["owner", "editor"],
  run: ["owner", "editor"],
  manage_members: ["owner"],
  manage_models: ["owner"],
};
export function permitsProjectAction(role: ProjectRole | null, action: ProjectPermission): boolean {
  return role !== null && (permissions[action]?.includes(role) ?? false);
}

async function roleFor(
  db: RepositoryDatabase,
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.projectId, projectId),
        isNull(users.disabledAt),
        isNull(projects.archivedAt),
      ),
    );
  return membership?.role ?? null;
}

/** Administrative status does not grant access to projects: membership is always required. */
export function createProjectAccessRepository(db: RepositoryDatabase) {
  return {
    async findMemberTarget(
      actorId: string,
      projectId: string,
      email: string,
    ): Promise<string | null> {
      if ((await roleFor(db, actorId, projectId)) !== "owner") throw new IdentityAccessError();
      const normalized = normalizeAccountEmail(email);
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, normalized), isNull(users.disabledAt)));
      return user?.id ?? null;
    },
    roleFor: (userId: string, projectId: string) => roleFor(db, userId, projectId),
    async listProjects(userId: string) {
      const rows = await db
        .select({ project: projects, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(
          and(
            eq(projectMembers.userId, userId),
            isNull(users.disabledAt),
            isNull(projects.archivedAt),
          ),
        )
        .orderBy(asc(projects.createdAt), asc(projects.id));
      return rows;
    },
    async createProject(userId: string, input: CreateProjectInput) {
      const fields = {
        name: normalizeName(input.name, "project name"),
        slug: normalizeKey(input.slug, "project slug"),
        description: normalizeDescription(input.description),
      };
      return db.transaction(async (tx) => {
        await lockIdentityMutation(tx);
        const [actor] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.disabledAt)));
        if (!actor) throw new IdentityAccessError();
        const [created] = await tx.insert(projects).values(fields).returning();
        if (!created) throw new Error("Project creation failed.");
        await tx.insert(projectMembers).values({ projectId: created.id, userId, role: "owner" });
        await tx.insert(auditEvents).values({
          projectId: created.id,
          actorType: "user",
          actorId: userId,
          action: "project.created",
          entityType: "project",
          entityId: created.id,
        });
        return created;
      });
    },
    async listMembers(actorId: string, projectId: string) {
      if (!(await roleFor(db, actorId, projectId))) throw new IdentityAccessError();
      return db
        .select({
          userId: users.id,
          displayName: users.displayName,
          email: users.email,
          role: projectMembers.role,
          disabledAt: users.disabledAt,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(eq(projectMembers.projectId, projectId))
        .orderBy(asc(users.email));
    },
    /** All membership mutations and account disables share a lock to preserve an active owner. */
    async setMember(
      actorId: string,
      projectId: string,
      userId: string,
      role: ProjectRole | null,
    ): Promise<void> {
      if (role !== null && !["owner", "editor", "viewer"].includes(role))
        throw new TypeError("Unknown project role.");
      await db.transaction(async (tx) => {
        await lockIdentityMutation(tx);
        if ((await roleFor(tx, actorId, projectId)) !== "owner") throw new IdentityAccessError();
        const [target] = await tx
          .select({ id: users.id, disabledAt: users.disabledAt })
          .from(users)
          .where(eq(users.id, userId));
        if (!target || (role !== null && target.disabledAt)) throw new IdentityAccessError();
        const [existing] = await tx
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
        if (existing?.role === "owner" && role !== "owner") {
          const [other] = await tx
            .select({ id: users.id })
            .from(projectMembers)
            .innerJoin(users, eq(users.id, projectMembers.userId))
            .where(
              and(
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.role, "owner"),
                ne(users.id, userId),
                isNull(users.disabledAt),
              ),
            )
            .limit(1);
          if (!other)
            throw new RepositoryConflictError(
              "LAST_PROJECT_OWNER",
              "A project must retain an active owner.",
            );
        }
        if (role === null)
          await tx
            .delete(projectMembers)
            .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
        else
          await tx
            .insert(projectMembers)
            .values({ projectId, userId, role })
            .onConflictDoUpdate({
              target: [projectMembers.projectId, projectMembers.userId],
              set: { role, updatedAt: new Date() },
            });
        await tx.insert(auditEvents).values({
          projectId,
          actorType: "user",
          actorId,
          action: role === null ? "project.member_removed" : "project.member_changed",
          entityType: "user",
          entityId: userId,
          data: { previousRole: existing?.role ?? null, role },
        });
      });
    },
  };
}
export type ProjectAccessRepository = ReturnType<typeof createProjectAccessRepository>;
