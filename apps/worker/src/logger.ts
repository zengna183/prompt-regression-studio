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

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
    };
  }
  return value;
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
      message,
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
