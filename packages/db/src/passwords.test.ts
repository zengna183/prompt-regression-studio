import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeAccountEmail,
  PasswordCapacityError,
  validatePassword,
  verifyPassword,
} from "./passwords.js";
import { permitsProjectAction } from "./repositories/project-access.js";

describe("password and session secrets", () => {
  it("uses random salts and verifies without trimming passwords", async () => {
    const password = "  correct horse battery staple  ";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(first).toMatch(/^scrypt-v1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password.trim(), first)).toBe(false);
  }, 15_000);
  it("rejects nonexistent/malformed credentials and attacker-chosen cost parameters", async () => {
    expect(await verifyPassword("invalid-password", null)).toBe(false);
    expect(await verifyPassword("invalid-password", "scrypt-v1$999999999$8$1$aa$bb")).toBe(false);
    expect(await verifyPassword("x".repeat(513), null)).toBe(false);
  }, 15_000);
  it("rejects short and oversized passwords but supports long Unicode passphrases", () => {
    expect(() => validatePassword("short")).toThrow();
    expect(() => validatePassword("x".repeat(129))).toThrow();
    expect(() => validatePassword("这是足够长且允许使用中文的登录密码短语")).not.toThrow();
  });
  it("bounds concurrent memory-intensive derivations and releases capacity afterward", async () => {
    const first = hashPassword("test passphrase number one");
    const second = hashPassword("test passphrase number two");
    await expect(hashPassword("test passphrase number three")).rejects.toBeInstanceOf(
      PasswordCapacityError,
    );
    await Promise.all([first, second]);
    await expect(hashPassword("test passphrase after release")).resolves.toMatch(/^scrypt-v1/);
  }, 15_000);
  it("generates unguessable distinct tokens and stores only their fingerprints", () => {
    const tokens = Array.from({ length: 100 }, createSessionToken);
    expect(new Set(tokens).size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
      expect(hashSessionToken(token)).not.toBe(token);
    }
    expect(hashSessionToken("invalid")).toBeNull();
    expect(hashSessionToken("x".repeat(4096))).toBeNull();
  });
  it("normalizes email case without accepting whitespace or non-email identifiers", () => {
    expect(normalizeAccountEmail(" Example@Company.COM ")).toBe("example@company.com");
    expect(() => normalizeAccountEmail("foo bar@example.com")).toThrow();
    expect(() => normalizeAccountEmail("admin")).toThrow();
  });
});

describe("project roles fail closed", () => {
  it("readers cannot mutate or invoke paid models", () => {
    expect(permitsProjectAction("viewer", "read")).toBe(true);
    for (const action of ["write", "run", "manage_models", "manage_members"] as const)
      expect(permitsProjectAction("viewer", action)).toBe(false);
  });
  it("editors can run evaluations but cannot change access or credentials", () => {
    expect(permitsProjectAction("editor", "write")).toBe(true);
    expect(permitsProjectAction("editor", "run")).toBe(true);
    expect(permitsProjectAction("editor", "manage_members")).toBe(false);
    expect(permitsProjectAction("editor", "manage_models")).toBe(false);
  });
  it("owners can manage membership but nonmembers have no access", () => {
    expect(permitsProjectAction("owner", "manage_members")).toBe(true);
    expect(permitsProjectAction(null, "read")).toBe(false);
    expect(permitsProjectAction(null, "run")).toBe(false);
  });
});
