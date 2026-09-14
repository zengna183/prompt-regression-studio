import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { closeHealthServer, startHealthServer } from "./health.js";
import type { Logger } from "./logger.js";

function createLoggerStub(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP health server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("worker health server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeHealthServer(server);
      server = undefined;
    }
  });

  it("reports liveness independently from Redis", async () => {
    server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      redis: { ping: vi.fn(() => Promise.reject(new Error("offline"))) },
      state: { isReady: () => false, isShuttingDown: () => false },
      logger: createLoggerStub(),
    });

    const response = await fetch(`${serverUrl(server)}/health/live`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ status: "ok", service: "worker" }),
    );
  });

  it("requires both worker readiness and Redis readiness", async () => {
    server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      redis: { ping: vi.fn(() => Promise.resolve("PONG")) },
      state: { isReady: () => true, isShuttingDown: () => false },
      logger: createLoggerStub(),
    });

    const response = await fetch(`${serverUrl(server)}/health/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
        dependencies: { redis: "up" },
      }),
    );
  });

  it("fails readiness during shutdown", async () => {
    server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      redis: { ping: vi.fn(() => Promise.resolve("PONG")) },
      state: { isReady: () => true, isShuttingDown: () => true },
      logger: createLoggerStub(),
    });

    const response = await fetch(`${serverUrl(server)}/health/ready`);
    expect(response.status).toBe(503);
  });
});
