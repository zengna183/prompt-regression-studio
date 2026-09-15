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
): number {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsedValue;
}

function readPort(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const port = readPositiveInteger(environment, name, fallback);
  if (port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return port;
}

export function readWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const logLevel = environment.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.has(logLevel as WorkerConfig["logLevel"])) {
    throw new Error("LOG_LEVEL must be one of: debug, info, warn, error");
  }

  return {
    redisUrl: environment.REDIS_URL ?? "redis://localhost:6379",
    concurrency: readPositiveInteger(environment, "WORKER_CONCURRENCY", 4),
    healthHost: environment.WORKER_HEALTH_HOST ?? "127.0.0.1",
    healthPort: readPort(environment, "WORKER_HEALTH_PORT", 4101),
    shutdownTimeoutMs: readPositiveInteger(environment, "WORKER_SHUTDOWN_TIMEOUT_MS", 30_000),
    logLevel: logLevel as WorkerConfig["logLevel"],
  };
}
