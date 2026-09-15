export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly idleTimeoutSeconds: number;
  readonly connectTimeoutSeconds: number;
  readonly ssl: boolean;
}

export class DatabaseConfigurationError extends Error {
  override readonly name = "DatabaseConfigurationError";

  constructor(message: string) {
    super(message);
  }
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new DatabaseConfigurationError(`${name} must be an integer from 1 to ${maximum}`);
  }

  return parsed;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new DatabaseConfigurationError(`${name} must be true or false`);
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) throw new DatabaseConfigurationError("DATABASE_URL is required");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DatabaseConfigurationError("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseConfigurationError("DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!parsed.hostname || parsed.pathname === "/" || parsed.pathname === "") {
    throw new DatabaseConfigurationError("DATABASE_URL must include a host and database name");
  }

  return raw;
}

/** Loads configuration without opening a connection or logging credentials. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const config = {
    url: readDatabaseUrl(env),
    poolMax: readPositiveInteger(env, "DATABASE_POOL_MAX", 10, 100),
    idleTimeoutSeconds: readPositiveInteger(env, "DATABASE_IDLE_TIMEOUT_SECONDS", 20, 3600),
    connectTimeoutSeconds: readPositiveInteger(env, "DATABASE_CONNECT_TIMEOUT_SECONDS", 10, 300),
    ssl: readBoolean(env, "DATABASE_SSL", false),
  };

  if (env.NODE_ENV === "production" && !config.ssl) {
    throw new DatabaseConfigurationError("DATABASE_SSL must be true in production");
  }

  return Object.freeze(config);
}
