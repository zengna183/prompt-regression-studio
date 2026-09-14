import { describe, expect, it } from "vitest";

import { readWorkerConfig } from "./config.js";

describe("readWorkerConfig", () => {
  it("uses safe local defaults", () => {
    expect(readWorkerConfig({})).toEqual({
      redisUrl: "redis://localhost:6379",
      concurrency: 4,
      healthHost: "127.0.0.1",
      healthPort: 4001,
      shutdownTimeoutMs: 30_000,
      logLevel: "info",
    });
  });

  it("rejects an invalid concurrency", () => {
    expect(() => readWorkerConfig({ WORKER_CONCURRENCY: "0" })).toThrow(
      "WORKER_CONCURRENCY must be a positive integer",
    );
  });

  it("rejects an invalid health port", () => {
    expect(() => readWorkerConfig({ WORKER_HEALTH_PORT: "70000" })).toThrow(
      "WORKER_HEALTH_PORT must be between 1 and 65535",
    );
  });
});
