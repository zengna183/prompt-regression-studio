import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Unit tests must not inherit a developer's deployment URL or local .env values.
  envDir: process.env.VITEST === "true" ? false : "../..",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
