import { createServer, type Server, type ServerResponse } from "node:http";

import type { Logger } from "./logger.js";

interface RedisHealthClient {
  ping(): Promise<string>;
}

export interface HealthState {
  isReady(): boolean;
  isShuttingDown(): boolean;
}

export interface HealthServerOptions {
  host: string;
  port: number;
  redis: RedisHealthClient;
  state: HealthState;
  logger: Logger;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Readonly<Record<string, unknown>>,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function isRedisReady(redis: RedisHealthClient): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutResult = new Promise<"TIMEOUT">((resolve) => {
      timeout = setTimeout(() => resolve("TIMEOUT"), 1_000);
      timeout.unref();
    });
    return (await Promise.race([redis.ping(), timeoutResult])) === "PONG";
  } catch {
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://worker.local").pathname;

      if (method !== "GET" && method !== "HEAD") {
        sendJson(response, 405, { status: "error", code: "method_not_allowed" });
        return;
      }

      if (path === "/health/live") {
        const live = !options.state.isShuttingDown();
        sendJson(response, live ? 200 : 503, {
          status: live ? "ok" : "shutting_down",
          service: "worker",
        });
        return;
      }

      if (path === "/health/ready") {
        const ready =
          !options.state.isShuttingDown() &&
          options.state.isReady() &&
          (await isRedisReady(options.redis));
        sendJson(response, ready ? 200 : 503, {
          status: ready ? "ok" : "not_ready",
          service: "worker",
          dependencies: { redis: ready ? "up" : "unavailable" },
        });
        return;
      }

      sendJson(response, 404, { status: "error", code: "not_found" });
    })().catch((error: unknown) => {
      options.logger.error("Health request failed", { error });
      if (!response.headersSent) {
        sendJson(response, 500, { status: "error", code: "health_check_failed" });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  return server;
}

export async function closeHealthServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeIdleConnections();
  });
}
