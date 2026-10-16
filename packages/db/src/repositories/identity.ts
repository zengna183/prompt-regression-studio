import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { RepositoryDatabase } from "../client.js";
import { RepositoryConflictError } from "../errors.js";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeAccountEmail,
  verifyPassword,
} from "../passwords.js";
import { auditEvents, projectMembers, projects, userSessions, users } from "../schema.js";

export interface AccountInput {
  email: string;
  displayName: string;
  password: string;
}
export interface AccountIdentity {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}
export class IdentityAccessError extends Error {
  constructor() {
    super("Account operation is not permitted.");
  }
}
const publicColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  isAdmin: users.isAdmin,
};
const SESSION_HOURS = 12;

function publicIdentity(row: AccountIdentity): AccountIdentity {
  return { id: row.id, email: row.email, displayName: row.displayName, isAdmin: row.isAdmin };
}
function accountFields(input: AccountInput) {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 120)
    throw new TypeError("Display name must contain 1-120 characters.");
  return { email: normalizeAccountEmail(input.email), displayName };
}
/** Shared with membership mutations so concurrent removals cannot orphan a project. */
export async function lockIdentityMutation(db: RepositoryDatabase): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('prs.identity.mutations'))`);
}
async function requireAdmin(db: RepositoryDatabase, actorId: string): Promise<void> {
  const [actor] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.isAdmin, true), isNull(users.disabledAt)));
  if (!actor) throw new IdentityAccessError();
}
async function record(db: RepositoryDatabase, actorId: string, action: string, targetId: string) {
  await db
    .insert(auditEvents)
    .values({ actorType: "user", actorId, action, entityType: "user", entityId: targetId });
}
async function ensureEmailAvailable(db: RepositoryDatabase, email: string) {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing)
    throw new RepositoryConflictError("ACCOUNT_EMAIL_EXISTS", "This account already exists.");
}

/** Server-only account/session storage. No HTTP routes are enabled by importing this module. */
export function createIdentityRepository(db: RepositoryDatabase) {
  return {
    /** Deployment-only bootstrap: exactly one first administrator, never a public registration API. */
    async bootstrap(input: AccountInput): Promise<AccountIdentity> {
      const fields = accountFields(input);
      const passwordHash = await hashPassword(input.password);
      return db.transaction(async (tx) => {
        await lockIdentityMutation(tx);
        const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
        if (existing)
          throw new RepositoryConflictError(
            "IDENTITY_ALREADY_INITIALIZED",
            "An account already exists; bootstrap is closed.",
          );
        const [created] = await tx
          .insert(users)
          .values({ ...fields, passwordHash, isAdmin: true })
          .returning(publicColumns);
        if (!created) throw new Error("Account creation failed.");
        await record(tx, created.id, "identity.bootstrap", created.id);
        return created;
      });
    },
    async createUser(actorId: string, input: AccountInput): Promise<AccountIdentity> {
      await requireAdmin(db, actorId);
      const fields = accountFields(input);
      const passwordHash = await hashPassword(input.password);
      return db.transaction(async (tx) => {
        await lockIdentityMutation(tx);
        await requireAdmin(tx, actorId);
        await ensureEmailAvailable(tx, fields.email);
        // No client-supplied role or administrator flag is copied into the insert.
        const [created] = await tx
          .insert(users)
          .values({ ...fields, passwordHash })
          .returning(publicColumns);
        if (!created) throw new Error("Account creation failed.");
        await record(tx, actorId, "identity.user_created", created.id);
        return created;
      });
    },
    async listUsers(actorId: string) {
      await requireAdmin(db, actorId);
      return db
        .select({ ...publicColumns, disabledAt: users.disabledAt })
        .from(users)
        .orderBy(asc(users.email))
        .limit(200);
    },
    async login(
      email: string,
      password: string,
    ): Promise<{ user: AccountIdentity; token: string; expiresAt: Date } | null> {
      let normalized: string | null = null;
      try {
        normalized = normalizeAccountEmail(email);
      } catch {
        /* Same result and derivation cost as an unknown account. */
      }
      const [snapshot] = normalized
        ? await db.select().from(users).where(eq(users.email, normalized))
        : [];
      const valid = await verifyPassword(
        password,
        snapshot && !snapshot.disabledAt ? snapshot.passwordHash : null,
      );
      if (!snapshot || !valid || snapshot.disabledAt) return null;
      const token = createSessionToken();
      const tokenHash = hashSessionToken(token)!;
      return db.transaction(async (tx) => {
        // Serialize with password changes/disable; an old verified password cannot mint a new session.
        const [current] = await tx
          .select()
          .from(users)
          .where(eq(users.id, snapshot.id))
          .for("update");
        if (
          !current ||
          current.disabledAt ||
          current.credentialVersion !== snapshot.credentialVersion ||
          current.passwordHash !== snapshot.passwordHash
        )
          return null;
        const [session] = await tx
          .insert(userSessions)
          .values({
            userId: current.id,
            tokenHash,
            credentialVersion: current.credentialVersion,
            expiresAt: sql`now() + interval '12 hours'`,
          })
          .returning({ expiresAt: userSessions.expiresAt });
        if (!session) throw new Error("Session creation failed.");
        await record(tx, current.id, "identity.login", current.id);
        return { user: publicIdentity(current), token, expiresAt: session.expiresAt };
      });
    },
    async resolveSession(token: string): Promise<AccountIdentity | null> {
      const tokenHash = hashSessionToken(token);
      if (!tokenHash) return null;
      const [identity] = await db
        .select(publicColumns)
        .from(userSessions)
        .innerJoin(users, eq(userSessions.userId, users.id))
        .where(
          and(
            eq(userSessions.tokenHash, tokenHash),
            isNull(userSessions.revokedAt),
            isNull(users.disabledAt),
            gt(userSessions.expiresAt, sql`now()`),
            eq(userSessions.credentialVersion, users.credentialVersion),
          ),
        );
      return identity ?? null;
    },
    async logout(token: string): Promise<void> {
      const tokenHash = hashSessionToken(token);
      if (!tokenHash) return;
      await db
        .update(userSessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(userSessions.tokenHash, tokenHash), isNull(userSessions.revokedAt)));
    },
    async changePassword(
      userId: string,
      currentPassword: string,
      nextPassword: string,
    ): Promise<boolean> {
      const [snapshot] = await db.select().from(users).where(eq(users.id, userId));
      const valid = await verifyPassword(
        currentPassword,
        snapshot && !snapshot.disabledAt ? snapshot.passwordHash : null,
      );
      if (!snapshot || !valid || snapshot.disabledAt) return false;
      const passwordHash = await hashPassword(nextPassword);
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        if (
          !current ||
          current.disabledAt ||
          current.credentialVersion !== snapshot.credentialVersion ||
          current.passwordHash !== snapshot.passwordHash
        )
          return false;
        await tx
          .update(users)
          .set({
            passwordHash,
            credentialVersion: sql`${users.credentialVersion} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, userId));
        await tx
          .update(userSessions)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
        await record(tx, userId, "identity.password_changed", userId);
        return true;
      });
    },
    async disableUser(actorId: string, userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await lockIdentityMutation(tx);
        await requireAdmin(tx, actorId);
        const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        if (!target) throw new IdentityAccessError();
        if (target.disabledAt) return;
        if (target.isAdmin) {
          const [another] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, userId)))
            .limit(1);
          if (!another)
            throw new RepositoryConflictError(
              "LAST_ADMIN",
              "The last active administrator cannot be disabled.",
            );
        }
        const ownedProjects = await tx
          .select({ id: projects.id })
          .from(projectMembers)
          .innerJoin(projects, eq(projectMembers.projectId, projects.id))
          .where(
            and(
              eq(projectMembers.userId, userId),
              eq(projectMembers.role, "owner"),
              isNull(projects.archivedAt),
            ),
          );
        for (const project of ownedProjects) {
          const [anotherOwner] = await tx
            .select({ id: users.id })
            .from(projectMembers)
            .innerJoin(users, eq(projectMembers.userId, users.id))
            .where(
              and(
                eq(projectMembers.projectId, project.id),
                eq(projectMembers.role, "owner"),
                ne(users.id, userId),
                isNull(users.disabledAt),
              ),
            )
            .limit(1);
          if (!anotherOwner)
            throw new RepositoryConflictError(
              "LAST_PROJECT_OWNER",
              "Transfer project ownership before disabling this account.",
            );
        }
        await tx
          .update(users)
          .set({
            disabledAt: sql`now()`,
            updatedAt: sql`now()`,
            credentialVersion: sql`${users.credentialVersion} + 1`,
          })
          .where(eq(users.id, userId));
        await tx
          .update(userSessions)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
        await record(tx, actorId, "identity.user_disabled", userId);
      });
    },
    sessionLifetimeHours: SESSION_HOURS,
  };
}
export type IdentityRepository = ReturnType<typeof createIdentityRepository>;
