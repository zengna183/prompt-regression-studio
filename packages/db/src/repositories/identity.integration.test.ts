import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient, type RepositoryDatabase } from "../client.js";
import { loadDatabaseConfig } from "../config.js";
import { auditEvents, projectMembers, projects, userSessions, users } from "../schema.js";
import {
  createIdentityRepository,
  resetAccountPasswordForDeployment,
  type AccountIdentity,
  type IdentityRepository,
} from "./identity.js";
import { createProjectAccessRepository, type ProjectAccessRepository } from "./project-access.js";

const PASSWORD = "test-only correct horse battery staple";
// Only a disposable test database, never the developer's configured DATABASE_URL.
describe.skipIf(!process.env.TEST_DATABASE_URL)("identity and project isolation", () => {
  let client: DatabaseClient;
  let identity: IdentityRepository;
  let access: ProjectAccessRepository;
  let admin: AccountIdentity;
  const accountIds: string[] = [];
  const projectIds: string[] = [];
  beforeAll(async () => {
    client = createDatabaseClient(
      loadDatabaseConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    identity = createIdentityRepository(client.db);
    access = createProjectAccessRepository(client.db);
    // bootstrap intentionally requires an empty users table; existing accounts are never deleted.
    admin = await identity.bootstrap({
      email: `admin-${randomUUID()}@example.test`,
      displayName: "Administrator",
      password: PASSWORD,
    });
    accountIds.push(admin.id);
  }, 30_000);
  afterAll(async () => {
    if (!client) return;
    if (projectIds.length) {
      await client.db.delete(auditEvents).where(inArray(auditEvents.projectId, projectIds));
      await client.db.delete(projects).where(inArray(projects.id, projectIds));
    }
    if (accountIds.length) {
      await client.db
        .delete(auditEvents)
        .where(
          or(inArray(auditEvents.actorId, accountIds), inArray(auditEvents.entityId, accountIds)),
        );
      await client.db.delete(users).where(inArray(users.id, accountIds));
    }
    await client.close();
  });
  async function user() {
    const created = await identity.createUser(admin.id, {
      email: `member-${randomUUID()}@example.test`,
      displayName: "Member",
      password: PASSWORD,
    });
    accountIds.push(created.id);
    return created;
  }
  async function project(userId: string) {
    const created = await access.createProject(userId, {
      name: "Private project",
      slug: `private-${randomUUID()}`,
    });
    projectIds.push(created.id);
    return created;
  }

  it("bootstrap closes after initialization and metadata never exposes credential hashes", async () => {
    expect(Object.keys(admin).sort()).toEqual(["displayName", "email", "id", "isAdmin"]);
    await expect(
      identity.bootstrap({
        email: "attacker@example.test",
        displayName: "Attacker",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_ALREADY_INITIALIZED" });
    const member = await user();
    expect(member.isAdmin).toBe(false);
    await expect(
      identity.createUser(member.id, {
        email: "not-allowed@example.test",
        displayName: "No",
        password: PASSWORD,
      }),
    ).rejects.toThrow("not permitted");
    const listed = await identity.listUsers(admin.id);
    expect(listed.every((row) => !("passwordHash" in row))).toBe(true);
  });
  it("email uniqueness is case-insensitive and failed credentials have one outcome", async () => {
    const member = await user();
    await expect(
      identity.createUser(admin.id, {
        email: member.email.toUpperCase(),
        displayName: "Duplicate",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_EMAIL_EXISTS" });
    expect(await identity.login(member.email, "incorrect password")).toBeNull();
    expect(await identity.login("unknown@example.test", PASSWORD)).toBeNull();
    expect(await identity.login("invalid email", PASSWORD)).toBeNull();
  }, 20_000);
  it("sessions are random, persisted only as hashes, and logout is idempotent", async () => {
    const member = await user();
    const first = await identity.login(member.email.toUpperCase(), PASSWORD);
    const second = await identity.login(member.email, PASSWORD);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.token).not.toBe(second!.token);
    expect(await identity.resolveSession(first!.token)).toEqual(member);
    const sessions = await client.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, member.id));
    expect(sessions).toHaveLength(2);
    expect(JSON.stringify(sessions)).not.toContain(first!.token);
    expect(sessions.every((row) => /^[a-f0-9]{64}$/.test(row.tokenHash))).toBe(true);
    await identity.logout(first!.token);
    await identity.logout(first!.token);
    expect(await identity.resolveSession(first!.token)).toBeNull();
    expect(await identity.resolveSession(second!.token)).toEqual(member);
    expect(await identity.resolveSession("malformed")).toBeNull();
  }, 20_000);
  it("expired sessions cannot be used", async () => {
    const member = await user();
    const login = await identity.login(member.email, PASSWORD);
    await client.db
      .update(userSessions)
      .set({ createdAt: sql`now() - interval '2 days'`, expiresAt: sql`now() - interval '1 day'` })
      .where(eq(userSessions.userId, member.id));
    expect(await identity.resolveSession(login!.token)).toBeNull();
  });
  it("password changes reject wrong passwords and revoke all previous sessions", async () => {
    const member = await user();
    const login = await identity.login(member.email, PASSWORD);
    expect(
      await identity.changePassword(
        member.id,
        "wrong password",
        "another long test-only passphrase",
      ),
    ).toBe(false);
    expect(await identity.resolveSession(login!.token)).toEqual(member);
    expect(
      await identity.changePassword(member.id, PASSWORD, "another long test-only passphrase"),
    ).toBe(true);
    expect(await identity.resolveSession(login!.token)).toBeNull();
    expect(await identity.login(member.email, PASSWORD)).toBeNull();
    expect(await identity.login(member.email, "another long test-only passphrase")).not.toBeNull();
  }, 20_000);
  it("deployment recovery revokes sessions without changing roles, reactivating or creating users", async () => {
    const member = await user();
    const owned = await project(member.id);
    const login = await identity.login(member.email, PASSWORD);
    const next = "deployment recovery test-only passphrase";
    await expect(
      resetAccountPasswordForDeployment(client.db, member.email, "short"),
    ).rejects.toThrow();
    expect(await identity.resolveSession(login!.token)).toEqual(member);
    await resetAccountPasswordForDeployment(client.db, member.email.toUpperCase(), next);
    expect(await identity.resolveSession(login!.token)).toBeNull();
    expect(await identity.login(member.email, PASSWORD)).toBeNull();
    expect((await identity.login(member.email, next))?.user).toEqual(member);
    expect(await access.roleFor(member.id, owned.id)).toBe("owner");
    await expect(
      resetAccountPasswordForDeployment(client.db, `unknown-${randomUUID()}@example.test`, next),
    ).rejects.toThrow();
    const disabled = await user();
    await identity.disableUser(admin.id, disabled.id);
    await expect(
      resetAccountPasswordForDeployment(client.db, disabled.email, next),
    ).rejects.toThrow();
    expect(await identity.login(disabled.email, next)).toBeNull();
    const events =
      await client.sql`select actor_type, data from audit_events where entity_id = ${member.id} and action = 'identity.password_reset'`;
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_type).toBe("system");
    expect(JSON.stringify(events)).not.toContain(next);
  }, 30_000);
  it.each(["change", "recovery"] as const)(
    "a pending login cannot survive password %s",
    async (operation) => {
      const member = await user();
      let unblock!: () => void;
      let verified!: () => void;
      const wait = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        verified = resolve;
      });
      const gatedDb: RepositoryDatabase = {
        select: client.db.select.bind(client.db),
        insert: client.db.insert.bind(client.db),
        update: client.db.update.bind(client.db),
        execute: client.db.execute.bind(client.db),
        transaction: async (callback) => {
          verified();
          await wait;
          return client.db.transaction(callback);
        },
      };
      const pendingLogin = createIdentityRepository(gatedDb).login(member.email, PASSWORD);
      await ready;
      try {
        if (operation === "change") {
          expect(
            await identity.changePassword(
              member.id,
              PASSWORD,
              "new password while login is pending",
            ),
          ).toBe(true);
        } else {
          await resetAccountPasswordForDeployment(
            client.db,
            member.email,
            "new password while login is pending",
          );
        }
      } finally {
        unblock();
      }
      expect(await pendingLogin).toBeNull();
    },
    20_000,
  );
  it("creating a project atomically assigns its owner; administrators cannot read unrelated projects", async () => {
    const member = await user();
    const owned = await project(member.id);
    expect(await access.roleFor(member.id, owned.id)).toBe("owner");
    expect(await access.roleFor(admin.id, owned.id)).toBeNull();
    expect((await access.listProjects(admin.id)).some((row) => row.project.id === owned.id)).toBe(
      false,
    );
    await expect(access.listMembers(admin.id, owned.id)).rejects.toThrow("not permitted");
    await expect(access.setMember(admin.id, owned.id, admin.id, "owner")).rejects.toThrow(
      "not permitted",
    );
  });
  it("viewers and editors cannot escalate their own membership; removal takes effect immediately", async () => {
    const owner = await user();
    const member = await user();
    const owned = await project(owner.id);
    await access.setMember(owner.id, owned.id, member.id, "viewer");
    expect(await access.roleFor(member.id, owned.id)).toBe("viewer");
    await expect(access.setMember(member.id, owned.id, member.id, "owner")).rejects.toThrow(
      "not permitted",
    );
    await access.setMember(owner.id, owned.id, member.id, "editor");
    await expect(access.setMember(member.id, owned.id, owner.id, null)).rejects.toThrow(
      "not permitted",
    );
    await access.setMember(owner.id, owned.id, member.id, null);
    expect(await access.listProjects(member.id)).toEqual([]);
    expect(await access.roleFor(member.id, owned.id)).toBeNull();
  });
  it("prevents removal/demotion of the last owner, including concurrent changes", async () => {
    const owner = await user();
    const other = await user();
    const owned = await project(owner.id);
    await expect(access.setMember(owner.id, owned.id, owner.id, null)).rejects.toMatchObject({
      code: "LAST_PROJECT_OWNER",
    });
    await access.setMember(owner.id, owned.id, other.id, "owner");
    const results = await Promise.allSettled([
      access.setMember(owner.id, owned.id, owner.id, "editor"),
      access.setMember(other.id, owned.id, other.id, "editor"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const owners = await client.db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, owned.id), eq(projectMembers.role, "owner")));
    expect(owners).toHaveLength(1);
  });
  it("account disable revokes sessions but cannot orphan a project or the administrator", async () => {
    const owner = await user();
    const other = await user();
    const owned = await project(owner.id);
    const login = await identity.login(owner.email, PASSWORD);
    await expect(identity.disableUser(admin.id, owner.id)).rejects.toMatchObject({
      code: "LAST_PROJECT_OWNER",
    });
    expect(await identity.resolveSession(login!.token)).toEqual(owner);
    await access.setMember(owner.id, owned.id, other.id, "owner");
    await identity.disableUser(admin.id, owner.id);
    expect(await identity.resolveSession(login!.token)).toBeNull();
    expect(await identity.login(owner.email, PASSWORD)).toBeNull();
    expect(await access.listProjects(owner.id)).toEqual([]);
    await expect(identity.disableUser(admin.id, admin.id)).rejects.toMatchObject({
      code: "LAST_ADMIN",
    });
  }, 20_000);
  it("archived projects are excluded and audit events contain no credentials", async () => {
    const member = await user();
    const owned = await project(member.id);
    await client.db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, owned.id));
    expect(await access.roleFor(member.id, owned.id)).toBeNull();
    expect(await access.listProjects(member.id)).toEqual([]);
    const events = await client.db
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.actorId, accountIds));
    expect(events.some((event) => event.action === "identity.password_changed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain("scrypt-v1");
  });
});
