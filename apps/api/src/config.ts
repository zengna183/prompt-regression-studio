import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .min(32)
    .max(512)
    .refine(isSafeAuthToken, "must not contain whitespace, commas, or control characters")
    .optional(),
);
const optionalBoolean = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
);
const webOrigin = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "WEB_ORIGIN must use http:// or https://",
  })
  .refine((value) => new URL(value).username === "" && new URL(value).password === "", {
    message: "WEB_ORIGIN must not contain credentials",
  });

const redisUrl = z
  .string()
  .url()
  .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), {
    message: "REDIS_URL must use redis:// or rediss://",
  });

function isSafeAuthToken(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "," || character.trim() === "" || codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
}

const RawConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    API_AUTH_TOKEN: optionalSecret,
    API_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(32 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    API_DOCS_ENABLED: optionalBoolean,
    API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
    API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    API_TRUST_PROXY: optionalBoolean.default(false),
    REDIS_URL: redisUrl.default("redis://127.0.0.1:6379"),
    DIAGNOSIS_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
    WEB_ORIGIN: webOrigin.default("http://localhost:5173"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DIAGNOSIS_PYTHON_EXECUTABLE: z.string().min(1).default("python"),
    DIAGNOSIS_PYTHONPATH: z.string().min(1).optional(),
    DIAGNOSIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(120_000),
    DIAGNOSIS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(2),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && config.API_AUTH_TOKEN === undefined) {
      context.addIssue({
        code: "custom",
        path: ["API_AUTH_TOKEN"],
        message: "API_AUTH_TOKEN is required in production and must contain at least 32 characters",
      });
    }
    if (config.DIAGNOSIS_RATE_LIMIT_MAX > config.API_RATE_LIMIT_MAX) {
      context.addIssue({
        code: "custom",
        path: ["DIAGNOSIS_RATE_LIMIT_MAX"],
        message: "DIAGNOSIS_RATE_LIMIT_MAX cannot exceed API_RATE_LIMIT_MAX",
      });
    }
    if (config.NODE_ENV === "production" && new URL(config.WEB_ORIGIN).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["WEB_ORIGIN"],
        message: "WEB_ORIGIN must use https:// in production",
      });
    }
  });

type RawApiConfig = z.infer<typeof RawConfigSchema>;

export type ApiConfig = Omit<RawApiConfig, "API_DOCS_ENABLED"> & {
  API_DOCS_ENABLED: boolean;
};

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config = RawConfigSchema.parse(env);
  return {
    ...config,
    API_DOCS_ENABLED: config.API_DOCS_ENABLED ?? config.NODE_ENV !== "production",
  };
}
