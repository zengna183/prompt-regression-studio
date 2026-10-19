import assert from "node:assert/strict";
import { createServer } from "node:http";
import { listen } from "./system-test-support.mjs";

/** Deterministic HTTP provider, not a substitute for paid-model quality acceptance. */
export async function fixtureProvider(apiKey) {
  const counts = new Map();
  let active = 0;
  let peak = 0;
  let hold = false;
  const pending = new Set();
  const server = createServer(async (req, res) => {
    active++;
    peak = Math.max(peak, active);
    res.once("close", () => {
      active--;
      pending.delete(res);
    });
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        assert(raw.length <= 1024 * 1024);
      }
      const body = JSON.parse(raw);
      const n = (counts.get(body.model) ?? 0) + 1;
      counts.set(body.model, n);
      if (body.model === "fault-timeout" || (body.model === "restart-generator" && hold)) {
        pending.add(res);
        return; // Client timeout, cancellation, or process termination closes this socket.
      }
      if (body.model === "fault-rate" && n <= 2) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: { message: "fixture rate limit" } }));
        return;
      }
      let text = "good";
      if (body.model === "system-judge") {
        const input = JSON.parse(body.messages[1].content);
        text = JSON.stringify({
          scores: input.framework.dimensions.map((dimension) => ({
            metricKey: dimension.id,
            score: (input.actualOutput === "bad" ? Math.min : Math.max)(
              ...dimension.scoringGuide.map((guide) => guide.score),
            ),
            confidence: 1,
            rationale: "Deterministic fixture score",
            evidence: [input.actualOutput],
          })),
        });
      } else if (body.model === "fault-judge") {
        text = "not JSON; must not become a successful score";
      } else {
        const system = body.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n");
        const user = body.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n");
        if (system.includes("BAD_POLICY") && user.includes("target-")) text = "bad";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `fixture-${n}`,
          model: body.model,
          choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    } catch {
      res.writeHead(400);
      res.end("fixture rejected malformed request");
    }
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    count: (model) => counts.get(model) ?? 0,
    holdRestart: (value) => {
      hold = value;
    },
    stats: () => ({ calls: Object.fromEntries(counts), peakConcurrency: peak }),
    async close() {
      for (const res of pending) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
