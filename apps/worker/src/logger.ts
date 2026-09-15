export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
  child(context: Readonly<Record<string, unknown>>): Logger;
}

const PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const sensitiveKeyPattern =
  /^(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)$/iu;
const connectionSecretPattern =
  /\b((?:redis|rediss|postgres|postgresql):\/\/[^:\s/@]+):[^@\s/]+@/giu;
const bearerTokenPattern = /\b(Bearer)\s+[^\s,]+/giu;
const maximumLogStringLength = 10_000;
const maximumObjectDepth = 8;
const maximumCollectionEntries = 100;

function sanitizeString(value: string): string {
  const bounded =
    value.length > maximumLogStringLength
      ? `${value.slice(0, maximumLogStringLength)}…[TRUNCATED]`
      : value;
  return bounded
    .replace(connectionSecretPattern, "$1:[REDACTED]@")
    .replace(bearerTokenPattern, "$1 [REDACTED]");
}

function normalizeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= maximumObjectDepth) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
      stack: value.stack === undefined ? undefined : sanitizeString(value.stack),
      cause: normalizeValue(value.cause, seen, depth + 1),
    };
  }
  if (Array.isArray(value)) {
    const normalized = value
      .slice(0, maximumCollectionEntries)
      .map((item) => normalizeValue(item, seen, depth + 1));
    if (value.length > maximumCollectionEntries) normalized.push("[TRUNCATED]");
    return normalized;
  }

  const entries = Object.entries(value).slice(0, maximumCollectionEntries);
  const normalized = Object.fromEntries(
    entries.map(([key, entryValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : normalizeValue(entryValue, seen, depth + 1),
    ]),
  );
  if (Object.keys(value).length > maximumCollectionEntries) {
    normalized.__truncated__ = true;
  }
  return normalized;
}

export function createLogger(
  minimumLevel: LogLevel,
  baseContext: Readonly<Record<string, unknown>> = {},
): Logger {
  const write = (
    level: LogLevel,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ): void => {
    if (PRIORITY[level] < PRIORITY[minimumLevel]) {
      return;
    }

    const normalizedContext = Object.fromEntries(
      Object.entries({ ...baseContext, ...context }).map(([key, value]) => [
        key,
        normalizeValue(value),
      ]),
    );
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: "worker",
      message: sanitizeString(message),
      ...normalizedContext,
    });

    if (level === "error") {
      console.error(entry);
    } else if (level === "warn") {
      console.warn(entry);
    } else {
      console.log(entry);
    }
  };

  return {
    debug: (message, context) => {
      write("debug", message, context);
    },
    info: (message, context) => {
      write("info", message, context);
    },
    warn: (message, context) => {
      write("warn", message, context);
    },
    error: (message, context) => {
      write("error", message, context);
    },
    child: (context) => createLogger(minimumLevel, { ...baseContext, ...context }),
  };
}
