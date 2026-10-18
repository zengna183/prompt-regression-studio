import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { installMonitoring } from "./monitoring.js";

describe("operational metrics", () => {
  it("requires separate credentials, aggregates status and never labels raw URLs", async () => {
    const app = Fastify();
    const snapshot = vi.fn(() =>
      Promise.resolve({
        queued: 3,
        running: 2,
        oldestQueuedSeconds: 12,
        oldestRunningSeconds: 22,
        failedLast24Hours: 1,
        pendingDispatches: 3,
        failedDispatches: 0,
        budgetsNearLimit: 1,
      }),
    );
    installMonitoring(app, "m".repeat(32), snapshot);
    app.get("/secret/:value", () => ({ ok: true }));
    try {
      expect((await app.inject("/metrics")).statusCode).toBe(401);
      expect(snapshot).not.toHaveBeenCalled();
      await app.inject("/secret/private-prompt");
      const response = await app.inject({
        url: "/metrics",
        headers: { authorization: `Bearer ${"m".repeat(32)}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("prs_evaluations_queued 3");
      expect(response.body).toContain('prs_http_responses_total{status="200"} 1');
      expect(response.body).not.toContain("private-prompt");
      await app.inject({ url: "/metrics", headers: { authorization: `Bearer ${"m".repeat(32)}` } });
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("reports unavailable storage without exposing error details or inventing zero backlog", async () => {
    const app = Fastify();
    installMonitoring(app, "m".repeat(32), () => Promise.reject(new Error("secret connection")));
    try {
      const response = await app.inject({
        url: "/metrics",
        headers: { authorization: `Bearer ${"m".repeat(32)}` },
      });
      expect(response.body).toContain("prs_database_up 0");
      expect(response.body).not.toContain("prs_evaluations_queued");
      expect(response.body).not.toContain("secret");
    } finally {
      await app.close();
    }
  });
});
