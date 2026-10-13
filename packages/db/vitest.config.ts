import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    // Integration suites share one disposable PostgreSQL database and migrations.
    fileParallelism: false,
  },
});
