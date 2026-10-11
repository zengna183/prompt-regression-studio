import { randomUUID } from "node:crypto";

import type { CreateDatasetVersion, DatasetVersion } from "@ai-chat-eval/contracts";
import type { DiagnosisEngine } from "@prompt-regression/diagnosis-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { CatalogService } from "./catalog-service.js";
import type { DatasetCaseGenerator } from "./dataset-generation.js";
import type { DatasetService } from "./dataset-service.js";
import { ApiError } from "./errors.js";

const datasetId = randomUUID();
const brief = "测试客服对退款和政策不明确问题的回答";
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function setup(options: { generator?: DatasetCaseGenerator; authToken?: string } = {}) {
  const version: DatasetVersion = {
    id: randomUUID(),
    datasetId,
    version: 1,
    status: "draft",
    source: "ai_generated",
    caseCount: 1,
    contentHash: "a".repeat(64),
    generationProvenance: { model: "test-model" },
    parentVersionId: null,
    changeSummary: "AI candidate",
    createdAt: new Date().toISOString(),
    publishedAt: null,
  };
  const listVersions = vi.fn(() => Promise.resolve([]));
  const createVersion = vi.fn((savedDatasetId: string, input: CreateDatasetVersion) => {
    void savedDatasetId;
    void input;
    return Promise.resolve(version);
  });
  const service: DatasetService = {
    list: vi.fn(),
    create: vi.fn(),
    listVersions,
    createVersion,
    listCases: vi.fn(() => Promise.resolve([])),
    publishVersion: vi.fn(),
  };
  const app = await buildApp({
    catalog: {} as CatalogService,
    diagnosisEngine: {} as DiagnosisEngine,
    datasetService: service,
    maxConcurrentDiagnoses: 1,
    ...(options.generator ? { datasetCaseGenerator: options.generator } : {}),
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  apps.push(app);
  return { app, createVersion, listVersions };
}

describe("AI dataset generation HTTP workflow", () => {
  it("checks dataset existence, generates and saves only a draft", async () => {
    const generate = vi.fn(() =>
      Promise.resolve({
        source: "ai_generated" as const,
        cases: [{ caseKey: "ai-001", input: "可以退款吗？" }],
        generationProvenance: { model: "model" },
      }),
    );
    const { app, createVersion, listVersions } = await setup({ generator: { generate } });
    const availability = await app.inject({
      method: "GET",
      url: "/v1/datasets/generation-availability",
    });
    expect(availability.json()).toEqual({ enabled: true });
    const result = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/generate`,
      payload: { brief, count: 1 },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json()).toMatchObject({ status: "draft", source: "ai_generated" });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(listVersions).toHaveBeenCalledWith(datasetId);
    expect(generate).toHaveBeenCalledWith({ brief, count: 1 });
    expect(createVersion).toHaveBeenCalledWith(
      datasetId,
      expect.objectContaining({ source: "ai_generated" }),
    );
  });

  it("rejects unauthenticated, invalid and missing-dataset requests before any model call", async () => {
    const token = "generation-auth-token-32-characters-minimum";
    const generate = vi.fn();
    const { app, listVersions, createVersion } = await setup({
      authToken: token,
      generator: { generate },
    });
    const url = `/v1/datasets/${datasetId}/generate`;
    expect(
      (await app.inject({ method: "POST", url, payload: { brief, count: 1 } })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}` },
          payload: { brief: "short", count: 100 },
        })
      ).statusCode,
    ).toBe(400);
    listVersions.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "Dataset not found"));
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}` },
          payload: { brief, count: 1 },
        })
      ).statusCode,
    ).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("does not claim generated provenance on caller-supplied versions", async () => {
    const { app, createVersion } = await setup();
    for (const payload of [
      { source: "ai_generated", cases: [{ caseKey: "case-1", input: "hello" }] },
      {
        source: "manual",
        cases: [{ caseKey: "case-1", input: "hello" }],
        generationProvenance: { model: "forged" },
      },
    ]) {
      const result = await app.inject({
        method: "POST",
        url: `/v1/datasets/${datasetId}/versions`,
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ code: "DATASET_SOURCE_RESERVED" });
    }
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("reports disabled generation without saving", async () => {
    const { app, createVersion } = await setup();
    expect(
      (await app.inject({ method: "GET", url: "/v1/datasets/generation-availability" })).json(),
    ).toEqual({ enabled: false });
    const result = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/generate`,
      payload: { brief, count: 1 },
    });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ code: "DATASET_GENERATION_UNAVAILABLE" });
    expect(createVersion).not.toHaveBeenCalled();
  });
});
