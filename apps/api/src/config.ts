import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DIAGNOSIS_PYTHON_EXECUTABLE: z.string().min(1).default("python"),
  DIAGNOSIS_PYTHONPATH: z.string().min(1).optional(),
  DIAGNOSIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(120_000),
  DIAGNOSIS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(2),
});

export type ApiConfig = z.infer<typeof ConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return ConfigSchema.parse(env);
}
