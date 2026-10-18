import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PostgresSql } from "@ai-chat-eval/db";

export interface OperationalSnapshot {
  queued: number;
  running: number;
  oldestQueuedSeconds: number;
  oldestRunningSeconds: number;
  failedLast24Hours: number;
  pendingDispatches: number;
  failedDispatches: number;
  budgetsNearLimit: number;
}

/** Fixed aggregate fields only: no project IDs, prompts, model keys or user identifiers. */
export function operationalSnapshot(sql: PostgresSql): () => Promise<OperationalSnapshot> {
  return async () =>
    sql.begin(async (tx) => {
      await tx`set local statement_timeout = '2000ms'`;
      const [runs] = await tx`
      select count(*) filter(where status='queued')::int as queued,
        count(*) filter(where status='running')::int as running,
        coalesce(extract(epoch from now()-min(created_at) filter(where status='queued')),0)::float as queued_age,
        coalesce(extract(epoch from now()-min(started_at) filter(where status='running')),0)::float as running_age,
        count(*) filter(where status in ('failed','partially_succeeded') and completed_at > now()-interval '24 hours')::int as failed
      from evaluation_runs where status in ('queued','running') or completed_at > now()-interval '24 hours'`;
      const [outbox] =
        await tx`select count(*) filter(where status in ('pending','dispatching'))::int as pending,
      count(*) filter(where status='failed')::int as failed from evaluation_run_dispatches where status <> 'dispatched'`;
      const [budgets] = await tx`select count(*)::int as count from experiments
      where status in ('queued','running') and cost_budget_usd > 0 and cost_reserved_usd >= cost_budget_usd * 0.9`;
      return {
        queued: Number(runs?.queued ?? 0),
        running: Number(runs?.running ?? 0),
        oldestQueuedSeconds: Number(runs?.queued_age ?? 0),
        oldestRunningSeconds: Number(runs?.running_age ?? 0),
        failedLast24Hours: Number(runs?.failed ?? 0),
        pendingDispatches: Number(outbox?.pending ?? 0),
        failedDispatches: Number(outbox?.failed ?? 0),
        budgetsNearLimit: Number(budgets?.count ?? 0),
      };
    });
}

export function installMonitoring(
  app: FastifyInstance,
  token: string,
  snapshot: () => Promise<OperationalSnapshot>,
) {
  if (!/^[^\s,]{32,512}$/u.test(token))
    throw new Error("METRICS_AUTH_TOKEN must contain 32-512 non-whitespace characters");
  const expected = createHash("sha256").update(token).digest();
  const responses = new Map<string, number>();
  let durationSum = 0;
  let count = 0;
  let lastCompletedAt = 0;
  let cached: OperationalSnapshot | null = null;
  let pending: Promise<void> | undefined;
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url === "/metrics" || request.routeOptions.url?.startsWith("/health/"))
      return;
    const status = String(reply.statusCode);
    responses.set(status, (responses.get(status) ?? 0) + 1);
    count++;
    durationSum += reply.elapsedTime / 1000;
  });
  app.get(
    "/metrics",
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      void reply.header("cache-control", "no-store");
      const presented = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/iu)?.[1] ?? "";
      if (!timingSafeEqual(expected, createHash("sha256").update(presented).digest()))
        return reply
          .code(401)
          .send({ code: "UNAUTHORIZED", message: "A metrics credential is required." });
      // Single-flight collection prevents scrapers from multiplying expensive DB scans.
      if (!pending && Date.now() - lastCompletedAt > 5_000) {
        pending = snapshot()
          .then((value) => {
            cached = value;
          })
          .catch(() => {
            cached = null;
          })
          .finally(() => {
            lastCompletedAt = Date.now();
            pending = undefined;
          });
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              cached = null;
              resolve();
            }, 3_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const lines: string[] = [];
      const metric = (name: string, value: number, type = "gauge") => {
        lines.push(
          `# TYPE ${name} ${type}`,
          `${name} ${Number.isFinite(value) ? Math.max(0, value) : 0}`,
        );
      };
      metric("prs_api_uptime_seconds", process.uptime());
      metric("prs_database_up", cached ? 1 : 0);
      metric("prs_http_request_duration_seconds_sum", durationSum, "counter");
      metric("prs_http_request_duration_seconds_count", count, "counter");
      lines.push("# TYPE prs_http_responses_total counter");
      for (const [status, value] of [...responses].sort())
        lines.push(`prs_http_responses_total{status="${status}"} ${value}`);
      if (cached) {
        for (const [name, value] of Object.entries({
          prs_evaluations_queued: cached.queued,
          prs_evaluations_running: cached.running,
          prs_evaluation_oldest_queued_seconds: cached.oldestQueuedSeconds,
          prs_evaluation_oldest_running_seconds: cached.oldestRunningSeconds,
          prs_evaluations_failed_last_24h: cached.failedLast24Hours,
          prs_dispatches_pending: cached.pendingDispatches,
          prs_dispatches_failed: cached.failedDispatches,
          prs_active_budgets_near_limit: cached.budgetsNearLimit,
        }))
          metric(name, value);
      }
      return reply.type("text/plain; version=0.0.4; charset=utf-8").send(`${lines.join("\n")}\n`);
    },
  );
}
