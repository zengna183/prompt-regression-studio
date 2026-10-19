import path from "node:path";
import { fileURLToPath } from "node:url";
import webConfig from "../apps/web/vite.config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Test only: serve the production build and proxy to the isolated API on the same origin.
// Do not load the developer's .env, and do not reuse this preview server for deployment.
export default {
  ...webConfig,
  root: path.join(root, "apps/web"),
  envDir: path.join(root, "artifacts/browser-empty-env"),
  preview: {
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.BROWSER_API_ORIGIN || "http://127.0.0.1:1",
        rewrite: (url) => url.replace(/^\/api/u, ""),
      },
    },
  },
};
