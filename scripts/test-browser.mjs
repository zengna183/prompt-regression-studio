import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";
import { browserFixtures } from "./browser-test-fixtures.mjs";
import { resolvePythonExecutable } from "./python-executable.mjs";
import { fixtureProvider } from "./system-test-provider.mjs";
import { eventually, freePort, managedProcess, testTargets } from "./system-test-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts/browser");
const expect = baseExpect.configure({ timeout: 20_000 });
const processes = [];
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "Chromium + production web build + real API/Worker/Python/PostgreSQL/Redis; API-seeded resources and deterministic local model, not paid-model quality acceptance",
  checks: [],
};
let database, redis, provider, browser, page;
const check = async (name, run) => {
  const start = performance.now();
  await run();
  report.checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
};

try {
  // The same strict target guard as system tests: never fall back to .env or application data.
  const targets = testTargets(process.env);
  const { createDatabaseClient, createIdentityRepository } =
    await import("../packages/db/dist/index.js");
  const require = createRequire(new URL("../packages/queue/package.json", import.meta.url));
  const { Redis } = require("ioredis");
  redis = new Redis(targets.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 5000,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  assert.equal(await redis.dbsize(), 0, "Refusing nonempty Redis test database");
  database = createDatabaseClient({
    url: targets.databaseUrl,
    poolMax: 5,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 3,
    ssl: false,
  });
  const tables =
    await database.sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`;
  assert.equal(tables.length, 0, "Refusing an existing test schema");

  // Fail before migration if Chromium is missing; do not silently skip acceptance.
  browser = await chromium.launch();
  const apiPort = await freePort();
  const workerPort = await freePort();
  const webPort = await freePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const origin = `http://127.0.0.1:${webPort}`;
  const providerKey = randomBytes(24).toString("hex");
  provider = await fixtureProvider(providerKey);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: targets.databaseUrl,
    DATABASE_SSL: "false",
    REDIS_URL: targets.redisUrl,
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    WEB_ORIGIN: origin,
    AUTH_MODE: "team",
    API_AUTH_TOKEN: "",
    API_RATE_LIMIT_MAX: "10000",
    DIAGNOSIS_RATE_LIMIT_MAX: "100",
    LOG_LEVEL: "error",
    METRICS_AUTH_TOKEN: randomBytes(32).toString("hex"),
    DATASET_GENERATION_MODEL: "",
    MODEL_PROVIDER_API_KEY: "",
    MODEL_PROVIDER_BASE_URL: provider.baseUrl,
    MODEL_PROVIDER_ALLOW_PRIVATE_NETWORK: "true",
    MODEL_PROVIDER_ALLOWED_HOSTS: "",
    MODEL_PROVIDER_TIMEOUT_MS: "3000",
    MODEL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    WORKER_HEALTH_HOST: "127.0.0.1",
    WORKER_HEALTH_PORT: String(workerPort),
    WORKER_CONCURRENCY: "2",
    DIAGNOSIS_PYTHON_EXECUTABLE: resolvePythonExecutable(
      root,
      process.env.PROMPT_REGRESSION_TEST_PYTHON,
    ),
    DIAGNOSIS_PYTHONPATH: path.join(root, "packages/python/core/src"),
  };
  const spawn = (name, args, extra = {}) => {
    const proc = managedProcess(name, args, { cwd: root, env: { ...env, ...extra } });
    processes.push(proc);
    return proc;
  };
  const ready = (proc, url) =>
    eventually(
      async () => {
        proc.assertAlive();
        try {
          return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      `service ready ${url}`,
      30_000,
    );
  await spawn("migration", ["packages/db/dist/migrate.js"]).complete();
  const email = "browser-test@example.invalid";
  const password = randomBytes(24).toString("base64url");
  await createIdentityRepository(database.db).bootstrap({
    email,
    password,
    displayName: "Browser Test",
  });
  const api = spawn("API", ["apps/api/dist/server.js"]);
  const worker = spawn("Worker", ["apps/worker/dist/index.js"]);
  await ready(api, `${base}/health/ready`);
  await ready(worker, `http://127.0.0.1:${workerPort}/health/ready`);
  let token;
  const http = async (method, route, body, status = 200, credential = token) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    // Never include authentication payloads in failure reports.
    assert.equal(
      response.status,
      status,
      `${method} ${route}: expected ${status}, received ${response.status}`,
    );
    return data;
  };
  token = (await http("POST", "/v1/auth/login", { email, password })).token;
  const resources = await browserFixtures(http, provider, providerKey);
  const projectPath = `/v1/projects/${resources.project.id}`;
  const vite = "apps/web/node_modules/vite/bin/vite.js";
  const config = "scripts/browser-vite.config.mjs";
  await spawn("production web build", [vite, "build", "--config", config], {
    NODE_ENV: "production",
    VITE_API_URL: "/api",
  }).complete(60_000);
  const web = spawn(
    "web preview",
    [vite, "preview", "--config", config, "--port", String(webPort)],
    {
      NODE_ENV: "production",
      BROWSER_API_ORIGIN: base,
    },
  );
  await ready(web, origin);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const login = async () => {
    await expect(page.getByRole("heading", { name: "登录衡鉴评测平台" })).toBeVisible();
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(password);
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/v1/auth/login") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const session = await (await response).json();
    assert(session.token, "Browser login did not return a session");
    await expect(page.getByRole("button", { name: / · 退出登录$/u })).toBeVisible();
    return session.token;
  };
  const experiments = () =>
    page.getByRole("navigation", { name: "主要功能" }).getByRole("button", { name: /实验与结果/u });
  await check("browser login, project visibility and private session storage", async () => {
    await page.goto(origin);
    const browserToken = await login();
    await expect(experiments()).toBeVisible();
    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));
    assert(
      !JSON.stringify(storage).includes(browserToken) &&
        !JSON.stringify(storage).includes(password),
      "Session token must not be persisted in Web Storage",
    );
  });
  let experimentId;
  await check("create and execute a comparison entirely through browser controls", async () => {
    await experiments().click();
    await expect(page.getByRole("heading", { name: "创建版本对比实验" })).toBeVisible();
    await page.getByLabel("实验名称", { exact: true }).fill("浏览器完整流程");
    await page
      .getByRole("combobox", { name: "要比较的 Prompt", exact: true })
      .selectOption(resources.prompt.id);
    await page
      .getByRole("combobox", { name: "基线版本（原来的版本）", exact: true })
      .selectOption(resources.baseline.id);
    await page
      .getByRole("combobox", { name: "候选版本（想验证的新版本）", exact: true })
      .selectOption(resources.candidate.id);
    await page
      .getByRole("combobox", { name: "评测集版本", exact: true })
      .selectOption(resources.datasetVersion.id);
    await page
      .getByRole("combobox", { name: "评判标准版本", exact: true })
      .selectOption(resources.framework.id);
    const created = page.waitForResponse(
      (r) => r.url().endsWith(`${projectPath}/experiments`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "保存实验计划" }).click();
    const response = await created;
    assert.equal(response.status(), 201);
    experimentId = (await response.json()).id;
    for (const [label, model] of [
      ["生成回答的模型", "system-generator"],
      ["负责评分的模型", "system-judge"],
    ]) {
      const group = page.getByRole("group", { name: label, exact: true });
      await group
        .getByRole("combobox", { name: "模型连接", exact: true })
        .selectOption(resources.connection.id);
      await group.getByRole("combobox", { name: "模型", exact: true }).selectOption(model);
    }
    const start = page.getByRole("button", { name: "确认并开始评测" });
    await expect(start).toBeDisabled();
    await page.getByRole("checkbox", { name: /我已确认模型和用例数量/u }).check();
    await start.click();
    await expect(page.getByRole("heading", { name: "查看为什么变好或变差" })).toBeVisible({
      timeout: 90_000,
    });
    const table = page.getByRole("table", { name: "各版本总体表现" });
    await expect(table.getByRole("row").filter({ hasText: "候选版本" })).toContainText("62.5%");
    const detail = await http("GET", `${projectPath}/experiments/${experimentId}`);
    assert.equal(detail.experiment.status, "succeeded");
    assert.equal(detail.progress.completedCaseExecutions, 16);
  });
  await check(
    "a temporary comparison failure shows a recoverable error, not a stuck screen",
    async () => {
      const comparison = `${origin}/api${projectPath}/experiments/${experimentId}/comparison`;
      const unavailable = (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "TEST_UNAVAILABLE",
            message: "Temporary acceptance-test outage",
          }),
        });
      // Only this response is injected; normal execution and all diagnosis results remain real.
      await page.route(comparison, unavailable);
      await page.getByRole("button", { name: "刷新状态", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("自动刷新已暂停");
      await page.unroute(comparison, unavailable);
      const recovered = page.waitForResponse(
        (response) => response.url() === comparison && response.status() === 200,
      );
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await recovered;
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("table", { name: "各版本总体表现" })).toBeVisible();
    },
  );
  const diagnose = async () => {
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/experiments/${experimentId}/diagnoses`) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "生成 / 更新诊断报告", exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 200);
    await expect(page.getByRole("heading", { name: "诊断报告", exact: true })).toBeVisible();
    return response.json();
  };
  let verified;
  await check(
    "diagnose, revert one block, inspect replay and update evidence in browser",
    async () => {
      await page
        .getByRole("combobox", { name: "要诊断的候选版本", exact: true })
        .selectOption(resources.candidate.id);
      const first = await diagnose();
      assert.equal(first.regression.cases.length, 3);
      assert(first.hypotheses.every((h) => h.verification_status !== "supported"));
      await page
        .getByRole("combobox", { name: "回退哪个段落？", exact: true })
        .selectOption("policy");
      const replay = page.getByRole("button", { name: "启动段落验证", exact: true });
      await expect(replay).toBeDisabled();
      await page
        .getByRole("checkbox", { name: "确认创建真实验证实验并承担新的模型调用费用" })
        .check();
      await replay.click();
      await page.getByRole("button", { name: "打开验证实验", exact: true }).click();
      await expect(page.getByRole("heading", { name: "查看为什么变好或变差" })).toBeVisible({
        timeout: 90_000,
      });
      await page
        .getByRole("combobox", { name: "历史实验", exact: true })
        .selectOption(experimentId);
      await page
        .getByRole("combobox", { name: "要诊断的候选版本", exact: true })
        .selectOption(resources.candidate.id);
      verified = await diagnose();
      assert(
        verified.hypotheses.some((h) => h.verification_status === "supported"),
        "Replay did not support the policy hypothesis",
      );
      await expect(page.getByRole("heading", { name: "已支持根因", exact: true })).toBeVisible();
    },
  );
  await check(
    "real JSON, Markdown and CSV browser downloads match the displayed report",
    async () => {
      await mkdir(artifacts, { recursive: true });
      for (const [name, extension] of [
        ["下载完整数据（JSON）", "json"],
        ["下载可读摘要（Markdown）", "md"],
        ["下载退化用例（CSV）", "csv"],
      ]) {
        const pending = page.waitForEvent("download");
        await page.getByRole("button", { name, exact: true }).click();
        const download = await pending;
        assert.equal(await download.failure(), null);
        assert(download.suggestedFilename().endsWith(`.${extension}`));
        const target = path.join(artifacts, `report.${extension}`);
        await download.saveAs(target);
        const content = await readFile(target, "utf8");
        if (extension === "json") assert.deepEqual(JSON.parse(content), verified);
        else
          assert(
            content.includes(verified.report_id),
            "Downloaded report has a different identity",
          );
        if (extension === "csv") assert.equal(content.trim().split(/\r?\n/u).length, 4);
      }
    },
  );
  await check(
    "reload preserves experiments but not browser credentials; logout revokes server session",
    async () => {
      await page.reload();
      const browserToken = await login();
      await experiments().click();
      await page
        .getByRole("combobox", { name: "历史实验", exact: true })
        .selectOption(experimentId);
      await expect(
        page.getByRole("heading", { name: "浏览器完整流程", exact: true }),
      ).toBeVisible();
      const revoked = page.waitForResponse((r) => r.url().endsWith("/v1/auth/logout"));
      await page.getByRole("button", { name: / · 退出登录$/u }).click();
      assert.equal((await revoked).status(), 200);
      await expect(page.getByRole("heading", { name: "登录衡鉴评测平台" })).toBeVisible();
      await http("GET", "/v1/projects", undefined, 401, browserToken);
    },
  );
  await check(
    "server-side revocation returns an open browser to login and removes private views",
    async () => {
      const expiredToken = await login();
      await experiments().click();
      await page
        .getByRole("combobox", { name: "历史实验", exact: true })
        .selectOption(experimentId);
      await expect(
        page.getByRole("heading", { name: "浏览器完整流程", exact: true }),
      ).toBeVisible();
      await createIdentityRepository(database.db).logout(expiredToken);
      await page.getByRole("button", { name: "刷新列表", exact: true }).click();
      await expect(page.getByRole("heading", { name: "登录衡鉴评测平台" })).toBeVisible();
      await expect(page.getByRole("status")).toContainText("登录已失效");
      await expect(page.getByRole("heading", { name: "浏览器完整流程", exact: true })).toHaveCount(
        0,
      );
      assert.deepEqual(pageErrors, [], "Uncaught JavaScript errors in browser");
      api.assertAlive();
      worker.assertAlive();
      web.assertAlive();
    },
  );
  report.provider = provider.stats();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  console.error(error);
  await mkdir(artifacts, { recursive: true });
  await page
    ?.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true })
    .catch(() => {});
  if (process.env.GITHUB_ACTIONS === "true")
    console.error(
      `::error title=Browser acceptance::${error.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const proc of [...processes].reverse()) await proc.stop().catch(() => {});
  redis?.disconnect();
  await database?.close().catch(() => {});
  await provider?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "acceptance.json"), JSON.stringify(report, null, 2));
}
