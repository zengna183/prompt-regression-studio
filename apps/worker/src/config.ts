export interface WorkerConfig {
  redisUrl: string;
  concurrency: number;
  healthHost: string;
  healthPort: number;
  shutdownTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = new Set<WorkerConfig["logLevel"]>(["debug", "info", "warn", "error"]);

function readPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0 || parsedValue > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${String(maximum)}`);
  }

  return parsedValue;
}

function readPort(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return readPositiveInteger(environment, name, fallback, 65_535);
}

function readRedisUrl(environment: NodeJS.ProcessEnv): string {
  const raw = environment.REDIS_URL?.trim() || "redis://localhost:6379";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("REDIS_URL must be a valid Redis URL");
  }

  if (!(["redis:", "rediss:"] as string[]).includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("REDIS_URL must use redis:// or rediss:// and include a host");
  }
  if (environment.NODE_ENV === "production" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use rediss:// in production");
  }
  return raw;
}

export function readWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const logLevel = environment.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.has(logLevel as WorkerConfig["logLevel"])) {
    throw new Error("LOG_LEVEL must be one of: debug, info, warn, error");
  }

  return {
    redisUrl: readRedisUrl(environment),
    concurrency: readPositiveInteger(environment, "WORKER_CONCURRENCY", 4, 128),
    healthHost: environment.WORKER_HEALTH_HOST?.trim() || "127.0.0.1",
    healthPort: readPort(environment, "WORKER_HEALTH_PORT", 4101),
    shutdownTimeoutMs: readPositiveInteger(
      environment,
      "WORKER_SHUTDOWN_TIMEOUT_MS",
      30_000,
      600_000,
    ),
    logLevel: logLevel as WorkerConfig["logLevel"],
  };
}
