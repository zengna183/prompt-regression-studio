import { describe, expect, it } from "vitest";

import { DatabaseConfigurationError, loadDatabaseConfig } from "./config.js";

describe("loadDatabaseConfig", () => {
  it("loads safe pool defaults", () => {
    expect(
      loadDatabaseConfig({ DATABASE_URL: "postgres://eval:eval@localhost:5432/eval" }),
    ).toEqual({
      url: "postgres://eval:eval@localhost:5432/eval",
      poolMax: 10,
      idleTimeoutSeconds: 20,
      connectTimeoutSeconds: 10,
      ssl: false,
    });
  });

  it("rejects absent or non-PostgreSQL URLs", () => {
    expect(() => loadDatabaseConfig({})).toThrow(DatabaseConfigurationError);
    expect(() => loadDatabaseConfig({ DATABASE_URL: "https://example.com/db" })).toThrow(
      /postgres/,
    );
  });

  it("validates numerical and boolean overrides", () => {
    expect(() =>
      loadDatabaseConfig({
        DATABASE_URL: "postgres://localhost/eval",
        DATABASE_POOL_MAX: "0",
      }),
    ).toThrow(/DATABASE_POOL_MAX/);
    expect(() =>
      loadDatabaseConfig({
        DATABASE_URL: "postgres://localhost/eval",
        DATABASE_SSL: "sometimes",
      }),
    ).toThrow(/DATABASE_SSL/);
  });

  it("requires encrypted PostgreSQL transport in production", () => {
    expect(() =>
      loadDatabaseConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://eval:secret@db.internal/eval",
      }),
    ).toThrow(/DATABASE_SSL/);

    expect(
      loadDatabaseConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://eval:secret@db.internal/eval",
        DATABASE_SSL: "true",
      }).ssl,
    ).toBe(true);
  });
});
