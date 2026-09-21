export interface WorkerConfig {
  redisUrl: string;
  modelProviderBaseUrl: string;
  modelProviderApiKey: string;
  modelProviderProduction: boolean;
  modelProviderAllowPrivateNetwork: boolean;
  modelProviderTimeoutMs: number;
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

function readBoolean(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;
  if (["true", "1", "yes", "on"].includes(rawValue.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(rawValue.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
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

  const production = environment.NODE_ENV === "production";
  const redisUrl = readRedisUrl(environment);
  const modelProviderBaseUrl =
    environment.MODEL_PROVIDER_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const modelProviderApiKey = environment.MODEL_PROVIDER_API_KEY?.trim() || "local-development-key";
  if (production && modelProviderApiKey === "local-development-key") {
    throw new Error("MODEL_PROVIDER_API_KEY is required in production");
  }

  return {
    redisUrl,
    modelProviderBaseUrl,
    modelProviderApiKey,
    modelProviderProduction: production,
    modelProviderAllowPrivateNetwork: readBoolean(
      environment,
      "MODEL_PROVIDER_ALLOW_PRIVATE_NETWORK",
      !production,
    ),
    modelProviderTimeoutMs: readPositiveInteger(
      environment,
      "MODEL_PROVIDER_TIMEOUT_MS",
      60_000,
      600_000,
    ),
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
