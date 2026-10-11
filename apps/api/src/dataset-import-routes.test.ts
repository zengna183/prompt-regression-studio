import { randomUUID } from "node:crypto";

import type { CreateDatasetVersion, DatasetVersion } from "@ai-chat-eval/contracts";
import type { DiagnosisEngine } from "@prompt-regression/diagnosis-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { CatalogService } from "./catalog-service.js";
import type { DatasetService } from "./dataset-service.js";
import { ApiError } from "./errors.js";

const datasetId = randomUUID();
const authToken = "test-import-token-32-characters-minimum";
const content = JSON.stringify([{ input: "你好", expectedOutput: "你好！" }]);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
function responseHash(response: { json(): unknown }): string {
  const payload = response.json();
  if (
    typeof payload === "object" &&
    payload !== null &&
    "previewHash" in payload &&
    typeof payload.previewHash === "string"
  )
    return payload.previewHash;
  throw new Error("Preview response is missing a hash");
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(authToken?: string) {
  const draft: DatasetVersion = {
    id: randomUUID(),
    datasetId,
    version: 1,
    status: "draft",
    source: "imported",
    caseCount: 1,
    contentHash: "a".repeat(64),
    generationProvenance: null,
    parentVersionId: null,
    changeSummary: null,
    createdAt: new Date().toISOString(),
    publishedAt: null,
  };
  const listVersions = vi.fn(() => Promise.resolve([]));
  const createVersion = vi.fn((datasetId: string, input: CreateDatasetVersion) => {
    void datasetId;
    void input;
    return Promise.resolve(draft);
  });
  const publishVersion = vi.fn();
  const service: DatasetService = {
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    listVersions,
    createVersion,
    listCases: vi.fn(() => Promise.resolve([])),
    publishVersion,
  };
  const app = await buildApp({
    catalog: {} as CatalogService,
    diagnosisEngine: {} as DiagnosisEngine,
    datasetService: service,
    maxConcurrentDiagnoses: 1,
    ...(authToken ? { authToken } : {}),
  });
  apps.push(app);
  return { app, createVersion, listVersions, publishVersion };
}

describe("dataset import HTTP workflow", () => {
  it("previews without writing and creates a traceable draft only after confirmation", async () => {
    const { app, createVersion, publishVersion } = await setup();
    const preview = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/import-preview`,
      payload: { format: "json", content },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ canImport: true, validRows: 1 });
    expect(createVersion).not.toHaveBeenCalled();
    const saved = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/import`,
      payload: { format: "json", content, previewHash: responseHash(preview) },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ status: "draft", source: "imported" });
    expect(createVersion.mock.calls[0]?.[0]).toBe(datasetId);
    expect(createVersion.mock.calls[0]?.[1]).toMatchObject({
      source: "imported",
      cases: [{ input: "你好" }],
      generationProvenance: {
        parser: "dataset-import/v1",
        format: "json",
        sourceHash: responseHash(preview),
        rowCount: 1,
      },
    });
    expect(publishVersion).not.toHaveBeenCalled();
    expect(saved.headers["cache-control"]).toBe("no-store");
  });
  it("revalidates rows and rejects changed content, wrong hashes and caller-controlled source flags", async () => {
    const { app, createVersion } = await setup();
    const preview = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/import-preview`,
      payload: { format: "json", content },
    });
    for (const payload of [
      {
        format: "json",
        content: JSON.stringify([{ input: "changed" }]),
        previewHash: responseHash(preview),
      },
      { format: "json", content, previewHash: "b".repeat(64) },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/datasets/${datasetId}/import`,
        payload,
      });
      expect(response.statusCode).toBe(409);
      const body: unknown = response.json();
      expect(body).toMatchObject({ code: "DATASET_IMPORT_PREVIEW_CHANGED" });
    }
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/import`,
      payload: {
        format: "json",
        content: '[{"input":"valid"},{"input":null}]',
        previewHash: responseHash(preview),
      },
    });
    expect(invalid.statusCode).toBe(422);
    const extra = await app.inject({
      method: "POST",
      url: `/v1/datasets/${datasetId}/import`,
      payload: {
        format: "json",
        content,
        previewHash: responseHash(preview),
        source: "ai_generated",
      },
    });
    expect(extra.statusCode).toBe(400);
    expect(createVersion).not.toHaveBeenCalled();
  });
  it("requires authentication, validates the dataset and hides internal failures", async () => {
    const { app, createVersion, listVersions } = await setup(authToken);
    const request = {
      method: "POST" as const,
      url: `/v1/datasets/${datasetId}/import-preview`,
      payload: { format: "json", content },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    listVersions.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "Dataset not found"));
    expect(
      (await app.inject({ ...request, headers: { authorization: `Bearer ${authToken}` } }))
        .statusCode,
    ).toBe(404);
    listVersions.mockRejectedValueOnce(new Error("private-database-password"));
    const failure = await app.inject({
      ...request,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain("private-database-password");
    expect(createVersion).not.toHaveBeenCalled();
  });
});
