import { defineConfig } from "drizzle-kit";
import { loadEnvFile } from "node:process";

if (!process.env.DATABASE_URL) {
  try {
    loadEnvFile("../../.env");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

const databaseUrl = process.env.DATABASE_URL?.trim();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
  migrations: {
    table: "__drizzle_migrations",
    schema: "public",
  },
  strict: true,
  verbose: true,
});
