import { randomUUID } from "node:crypto";

import type {
  CreateProject,
  EvaluationFramework,
  FrameworkVersion,
  Project,
  Prompt,
  PromptVersion,
} from "@ai-chat-eval/contracts";
import {
  DiagnosisEngineError,
  type DiagnosisEngine,
  type DiagnosisEngineErrorCode,
  type DiagnosisOptions,
  type JsonObject,
} from "@prompt-regression/diagnosis-engine";
import { describe, expect, it } from "vitest";

import { buildApp, type BuildAppOptions } from "./app.js";
import type { CatalogService } from "./catalog-service.js";
import type {
  DiagnosisRunDetail,
  DiagnosisRunSummary,
  DiagnosisStore,
  ListDiagnosisRunsInput,
} from "./diagnosis-store.js";

class TestCatalog implements CatalogService {
  readonly projects: Project[] = [];

  listProjects(): Promise<Project[]> {
    return Promise.resolve(this.projects);
  }

  createProject(input: CreateProject): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(project);
    return Promise.resolve(project);
  }

  listPrompts(): Promise<Prompt[]> {
    return Promise.resolve([]);
  }
  createPrompt(): Promise<Prompt> {
    return Promise.reject(new Error("not used in this test"));
  }
  listPromptVersions(): Promise<PromptVersion[]> {
    return Promise.resolve([]);
  }
  createPromptVersion(): Promise<PromptVersion> {
    return Promise.reject(new Error("not used in this test"));
  }
  publishPromptVersion(): Promise<PromptVersion> {
    return Promise.reject(new Error("not used in this test"));
  }
  listFrameworks(): Promise<EvaluationFramework[]> {
    return Promise.resolve([]);
  }
  createFramework(): Promise<EvaluationFramework> {
    return Promise.reject(new Error("not used in this test"));
  }
  listFrameworkVersions(): Promise<FrameworkVersion[]> {
    return Promise.resolve([]);
  }
  createFrameworkVersion(): Promise<FrameworkVersion> {
    return Promise.reject(new Error("not used in this test"));
  }
  publishFrameworkVersion(): Promise<FrameworkVersion> {
    return Promise.reject(new Error("not used in this test"));
  }
}

describe("API", () => {
  it("reports liveness", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("adds browser security headers and normalizes unsafe request IDs", async () => {
    const app = await buildTestApp();
    const valid = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "request-123" },
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "line-break-is-not-allowed/" },
    });

    expect(valid.headers["x-request-id"]).toBe("request-123");
    expect(valid.headers["x-content-type-options"]).toBe("nosniff");
    expect(valid.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(invalid.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await app.close();
  });

  it("protects API data with a bearer token while keeping health checks public", async () => {
    const authToken = "test-security-token-that-is-long-enough";
    const app = await buildTestApp(
      new TestCatalog(),
      new RecordingDiagnosisEngine(),
      2,
      undefined,
      { authToken },
    );

    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);

    const missing = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(missing.headers["www-authenticate"]).toContain("Bearer");
    expect(missing.body).not.toContain(authToken);

    const authorized = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/projects",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(preflight.statusCode).toBe(204);
    await app.close();
  });

  it("disables documentation and refuses unauthenticated production mode", async () => {
    await expect(
      buildTestApp(new TestCatalog(), new RecordingDiagnosisEngine(), 2, undefined, {
        productionMode: true,
      }),
    ).rejects.toThrow(/authToken/);

    const app = await buildTestApp(
      new TestCatalog(),
      new RecordingDiagnosisEngine(),
      2,
      undefined,
      {
        productionMode: true,
        authToken: "production-security-token-is-long-enough",
        docsEnabled: false,
      },
    );
    const response = await app.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
    await app.close();
  });

  it("limits abusive traffic without rate limiting orchestrator health checks", async () => {
    const app = await buildTestApp(
      new TestCatalog(),
      new RecordingDiagnosisEngine(),
      2,
      undefined,
      { rateLimitMax: 2, diagnosisRateLimitMax: 1 },
    );

    expect((await app.inject({ method: "GET", url: "/v1/projects" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/projects" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("applies a stricter limit to expensive diagnosis requests", async () => {
    const engine = new RecordingDiagnosisEngine();
    const app = await buildTestApp(new TestCatalog(), engine, 2, undefined, {
      rateLimitMax: 100,
      diagnosisRateLimitMax: 1,
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(engine.callCount).toBe(1);
    await app.close();
  });

  it("rejects oversized bodies before diagnosis work starts", async () => {
    const engine = new RecordingDiagnosisEngine();
    const app = await buildTestApp(new TestCatalog(), engine, 2, undefined, {
      bodyLimitBytes: 1_024,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: { ...canonicalBundle, padding: "x".repeat(2_000) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(engine.callCount).toBe(0);
    await app.close();
  });

  it("validates and creates a project", async () => {
    const app = await buildTestApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { slug: "Not valid", name: "x" },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { slug: "customer-support", name: "Customer Support" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      slug: "customer-support",
      name: "Customer Support",
    });
    await app.close();
  });

  it("runs diagnosis for a canonical bundle and forwards an AbortSignal", async () => {
    const engine = new RecordingDiagnosisEngine();
    const app = await buildTestApp(new TestCatalog(), engine);

    const response = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(diagnosisReport);
    expect(engine.receivedBundle).toEqual(canonicalBundle);
    expect(engine.receivedSignal).toBeInstanceOf(AbortSignal);
    await app.close();
  });

  it("persists a successful diagnosis and exposes list and detail history", async () => {
    const store = new MemoryDiagnosisStore();
    const engine: DiagnosisEngine = {
      diagnose: () => Promise.resolve(persistableDiagnosisReport),
    };
    const app = await buildTestApp(new TestCatalog(), engine, 2, store);

    const response = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });

    expect(response.statusCode).toBe(200);
    const runId = response.headers["x-diagnosis-run-id"];
    expect(runId).toEqual(expect.any(String));
    expect(response.headers.location).toBe(`/v1/diagnoses/${String(runId)}`);

    const list = await app.inject({ method: "GET", url: "/v1/diagnoses" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ id: runId, bundleId: "bundle_test", status: "succeeded" }],
    });

    const detail = await app.inject({ method: "GET", url: `/v1/diagnoses/${String(runId)}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: runId,
      inputBundleHash: "a".repeat(64),
      reportId: "report_test",
      report: persistableDiagnosisReport,
    });
    await app.close();
  });

  it("stores a safe terminal failure without leaking engine diagnostics", async () => {
    const store = new MemoryDiagnosisStore();
    const engine = new RejectingDiagnosisEngine(
      new DiagnosisEngineError("DIAGNOSIS_ENGINE_TIMEOUT", "secret provider output"),
    );
    const app = await buildTestApp(new TestCatalog(), engine, 2, store);

    const response = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });

    expect(response.statusCode).toBe(504);
    const [failed] = await store.list({});
    expect(failed).toMatchObject({
      status: "failed",
      failureCode: "DIAGNOSIS_ENGINE_TIMEOUT",
      failureMessage: "The diagnosis operation timed out.",
    });
    expect(JSON.stringify(failed)).not.toContain("secret provider output");
    await app.close();
  });

  it("rejects a non-object diagnosis payload before calling the engine", async () => {
    const engine = new RecordingDiagnosisEngine();
    const app = await buildTestApp(new TestCatalog(), engine);

    const response = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: ["not", "a", "bundle"],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(engine.callCount).toBe(0);
    await app.close();
  });

  it.each<readonly [DiagnosisEngineErrorCode, number]>([
    ["DIAGNOSIS_ENGINE_INVALID_INPUT", 400],
    ["DIAGNOSIS_ENGINE_INPUT_TOO_LARGE", 413],
    ["DIAGNOSIS_ENGINE_TIMEOUT", 504],
    ["DIAGNOSIS_ENGINE_START_FAILED", 503],
    ["DIAGNOSIS_ENGINE_PROCESS_FAILED", 502],
    ["DIAGNOSIS_ENGINE_INVALID_OUTPUT", 502],
  ])("maps %s to HTTP %i without exposing engine diagnostics", async (code, statusCode) => {
    const engine = new RejectingDiagnosisEngine(
      new DiagnosisEngineError(code, "unsafe-public-engine-message", {
        operatorDiagnostic: "operator-secret-token",
      }),
    );
    const app = await buildTestApp(new TestCatalog(), engine);

    const response = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ code });
    expect(response.body).not.toContain("unsafe-public-engine-message");
    expect(response.body).not.toContain("operator-secret-token");
    await app.close();
  });

  it("returns 503 while the configured diagnosis concurrency is saturated", async () => {
    const engine = new BlockingDiagnosisEngine();
    const app = await buildTestApp(new TestCatalog(), engine, 1);

    const firstResponse = app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });
    await engine.started;

    const saturated = await app.inject({
      method: "POST",
      url: "/v1/diagnoses",
      payload: canonicalBundle,
    });
    expect(saturated.statusCode).toBe(503);
    expect(saturated.json()).toMatchObject({ code: "DIAGNOSIS_CAPACITY_EXCEEDED" });

    engine.release();
    expect((await firstResponse).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/diagnoses",
          payload: canonicalBundle,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });
});

const canonicalBundle = {
  schema_version: "prompt-regression.bundle/v1alpha1",
  bundle_id: "bundle_test",
} as const;

const diagnosisReport = {
  schema_version: "prompt-regression.report/v1alpha1",
  bundle_id: "bundle_test",
  outcome: "supported",
} as const;

const persistableDiagnosisReport = {
  ...diagnosisReport,
  report_id: "report_test",
  input_bundle_hash: "a".repeat(64),
} as const;

async function buildTestApp(
  catalog: CatalogService = new TestCatalog(),
  diagnosisEngine: DiagnosisEngine = new RecordingDiagnosisEngine(),
  maxConcurrentDiagnoses = 2,
  diagnosisStore?: DiagnosisStore,
  securityOptions: Partial<
    Omit<
      BuildAppOptions,
      "catalog" | "diagnosisEngine" | "diagnosisStore" | "maxConcurrentDiagnoses"
    >
  > = {},
) {
  return await buildApp({
    catalog,
    diagnosisEngine,
    maxConcurrentDiagnoses,
    ...(diagnosisStore ? { diagnosisStore } : {}),
    ...securityOptions,
  });
}

class MemoryDiagnosisStore implements DiagnosisStore {
  readonly #runs = new Map<string, DiagnosisRunDetail>();

  begin(bundleId: string): Promise<DiagnosisRunSummary> {
    const now = new Date().toISOString();
    const run: DiagnosisRunDetail = {
      id: randomUUID(),
      projectId: null,
      bundleId,
      status: "running",
      inputBundleHash: null,
      reportId: null,
      report: null,
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      startedAt: now,
      completedAt: null,
    };
    this.#runs.set(run.id, run);
    return Promise.resolve(run);
  }

  complete(id: string, report: JsonObject): Promise<DiagnosisRunDetail> {
    const current = this.#required(id);
    const inputBundleHash = report.input_bundle_hash;
    const reportId = report.report_id;
    if (typeof inputBundleHash !== "string" || typeof reportId !== "string") {
      throw new TypeError("test report identity is missing");
    }
    const completed: DiagnosisRunDetail = {
      ...current,
      status: "succeeded",
      inputBundleHash,
      reportId,
      report,
      completedAt: new Date().toISOString(),
    };
    this.#runs.set(id, completed);
    return Promise.resolve(completed);
  }

  fail(
    id: string,
    code: DiagnosisEngineErrorCode | "INTERNAL_ERROR",
    message: string,
    cancelled: boolean,
  ): Promise<DiagnosisRunDetail> {
    const current = this.#required(id);
    const failed: DiagnosisRunDetail = {
      ...current,
      status: cancelled ? "cancelled" : "failed",
      failureCode: code,
      failureMessage: message,
      completedAt: new Date().toISOString(),
    };
    this.#runs.set(id, failed);
    return Promise.resolve(failed);
  }

  get(id: string): Promise<DiagnosisRunDetail | null> {
    return Promise.resolve(this.#runs.get(id) ?? null);
  }

  list(input: ListDiagnosisRunsInput): Promise<readonly DiagnosisRunSummary[]> {
    const runs = [...this.#runs.values()].filter(
      (run) =>
        (input.projectId === undefined || run.projectId === input.projectId) &&
        (input.status === undefined || run.status === input.status),
    );
    return Promise.resolve(
      runs.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50)),
    );
  }

  #required(id: string): DiagnosisRunDetail {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`missing diagnosis run ${id}`);
    return run;
  }
}

class RecordingDiagnosisEngine implements DiagnosisEngine {
  callCount = 0;
  receivedBundle: unknown;
  receivedSignal: AbortSignal | undefined;

  diagnose(bundle: unknown, options: DiagnosisOptions = {}): Promise<JsonObject> {
    this.callCount += 1;
    this.receivedBundle = bundle;
    this.receivedSignal = options.signal;
    return Promise.resolve(diagnosisReport);
  }
}

class RejectingDiagnosisEngine implements DiagnosisEngine {
  constructor(readonly error: Error) {}

  diagnose(): Promise<JsonObject> {
    return Promise.reject(this.error);
  }
}

class BlockingDiagnosisEngine implements DiagnosisEngine {
  readonly started: Promise<void>;
  readonly #gate: Promise<void>;
  #markStarted: () => void = () => undefined;
  #release: () => void = () => undefined;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  async diagnose(): Promise<JsonObject> {
    this.#markStarted();
    await this.#gate;
    return diagnosisReport;
  }

  release(): void {
    this.#release();
  }
}
