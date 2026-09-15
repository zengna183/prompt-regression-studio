import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker logger", () => {
  it("redacts nested secrets, bearer tokens, and connection passwords", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger("info");

    logger.info("provider failed with Bearer visible-token", {
      nested: {
        apiKey: "provider-secret",
        redis: "rediss://worker:redis-password@cache.internal:6379",
      },
    });

    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("visible-token");
    expect(line).not.toContain("provider-secret");
    expect(line).not.toContain("redis-password");
  });

  it("handles circular and oversized log context without crashing", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const circular: Record<string, unknown> = { text: "x".repeat(10_100) };
    circular.self = circular;

    expect(() => createLogger("info").info("safe", { circular })).not.toThrow();
    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain("[CIRCULAR]");
    expect(line).toContain("[TRUNCATED]");
  });
});
