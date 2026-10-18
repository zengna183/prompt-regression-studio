import { createServer, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

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
  database?: () => Promise<void>;
  metricsToken?: string;
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
  if (options.metricsToken && !/^[^\s,]{32,512}$/u.test(options.metricsToken))
    throw new Error("METRICS_AUTH_TOKEN must contain 32-512 non-whitespace characters");
  let databaseProbe: Promise<boolean> | undefined;
  async function databaseReady(): Promise<boolean> {
    if (!options.database) return true;
    databaseProbe ??= options
      .database()
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        databaseProbe = undefined;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        databaseProbe,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
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
        const [redisUp, databaseUp] = await Promise.all([
          isRedisReady(options.redis),
          databaseReady(),
        ]);
        const ready =
          !options.state.isShuttingDown() && options.state.isReady() && redisUp && databaseUp;
        sendJson(response, ready ? 200 : 503, {
          status: ready ? "ok" : "not_ready",
          service: "worker",
          dependencies: {
            redis: redisUp ? "up" : "unavailable",
            database: databaseUp ? "up" : "unavailable",
          },
        });
        return;
      }

      if (path === "/metrics" && options.metricsToken) {
        const token = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/iu)?.[1] ?? "";
        if (
          !timingSafeEqual(
            createHash("sha256").update(token).digest(),
            createHash("sha256").update(options.metricsToken).digest(),
          )
        ) {
          sendJson(response, 401, { code: "UNAUTHORIZED" });
          return;
        }
        const [redisUp, databaseUp] = await Promise.all([
          isRedisReady(options.redis),
          databaseReady(),
        ]);
        const values = {
          prs_worker_ready: Number(
            options.state.isReady() && !options.state.isShuttingDown() && redisUp && databaseUp,
          ),
          prs_worker_database_up: Number(databaseUp),
          prs_worker_redis_up: Number(redisUp),
          prs_worker_uptime_seconds: process.uptime(),
        };
        response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          Object.entries(values)
            .map(([name, value]) => `# TYPE ${name} gauge\n${name} ${value}\n`)
            .join(""),
        );
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
