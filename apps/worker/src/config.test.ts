import { describe, expect, it } from "vitest";

import { readWorkerConfig } from "./config.js";

describe("readWorkerConfig", () => {
  it("uses safe local defaults", () => {
    expect(readWorkerConfig({})).toEqual({
      redisUrl: "redis://localhost:6379",
      modelProviderBaseUrl: "http://127.0.0.1:11434",
      modelProviderApiKey: "local-development-key",
      modelProviderProduction: false,
      modelProviderAllowPrivateNetwork: true,
      modelProviderTimeoutMs: 60_000,
      concurrency: 4,
      healthHost: "127.0.0.1",
      healthPort: 4101,
      shutdownTimeoutMs: 30_000,
      logLevel: "info",
    });
  });

  it("rejects an invalid concurrency", () => {
    expect(() => readWorkerConfig({ WORKER_CONCURRENCY: "0" })).toThrow(
      "WORKER_CONCURRENCY must be an integer from 1 to 128",
    );
    expect(() => readWorkerConfig({ WORKER_CONCURRENCY: "129" })).toThrow(/WORKER_CONCURRENCY/);
  });

  it("rejects an invalid health port", () => {
    expect(() => readWorkerConfig({ WORKER_HEALTH_PORT: "70000" })).toThrow(
      "WORKER_HEALTH_PORT must be an integer from 1 to 65535",
    );
  });

  it("validates Redis URLs and requires encrypted transport in production", () => {
    expect(() => readWorkerConfig({ REDIS_URL: "https://example.com" })).toThrow(/REDIS_URL/);
    expect(() =>
      readWorkerConfig({ NODE_ENV: "production", REDIS_URL: "redis://cache.internal:6379" }),
    ).toThrow(/rediss/);
    expect(
      readWorkerConfig({
        NODE_ENV: "production",
        REDIS_URL: "rediss://worker:secret@cache.internal:6379",
        MODEL_PROVIDER_API_KEY: "production-provider-key",
      }).redisUrl,
    ).toBe("rediss://worker:secret@cache.internal:6379");
  });

  it("caps shutdown time to avoid configuration overflow", () => {
    expect(() => readWorkerConfig({ WORKER_SHUTDOWN_TIMEOUT_MS: "600001" })).toThrow(
      /WORKER_SHUTDOWN_TIMEOUT_MS/,
    );
  });
});
