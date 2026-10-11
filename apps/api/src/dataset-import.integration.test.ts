import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  loadDatabaseConfig,
  projects,
  type DatabaseClient,
} from "@ai-chat-eval/db";
import type { DiagnosisEngine } from "@prompt-regression/diagnosis-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { CatalogService } from "./catalog-service.js";
import { createDatabaseDatasetService } from "./database-dataset-service.js";

function objectResponse(response: { json(): unknown }): Record<string, unknown> {
  const value = response.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw new Error("Expected a JSON object response");
}

// CI runs the database migration/integration suite before this package.
// Only an explicit migrated disposable TEST_DATABASE_URL is used; never the developer's .env.
describe.skipIf(!process.env.TEST_DATABASE_URL)("dataset import PostgreSQL workflow", () => {
  let client: DatabaseClient;
  beforeAll(() => {
    client = createDatabaseClient(
      loadDatabaseConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
  });
  afterAll(async () => {
    await client?.close();
  });

  it("persists complete draft cases and provenance, rejects partial and duplicate imports", async () => {
    const rollback = new Error("rollback isolated import fixture");
    try {
      await client.db.transaction(async (tx) => {
        const [project] = await tx
          .insert(projects)
          .values({ slug: `import-${randomUUID()}`, name: "Import test" })
          .returning();
        if (!project) throw new Error("Project fixture missing");
        const service = createDatabaseDatasetService(tx);
        const dataset = await service.create(project.id, {
          key: "import-dialogues",
          name: "Import dialogues",
        });
        const app = await buildApp({
          catalog: {} as CatalogService,
          diagnosisEngine: {} as DiagnosisEngine,
          datasetService: service,
          maxConcurrentDiagnoses: 1,
        });
        try {
          const input = {
            format: "csv",
            content: 'caseKey,input,expectedOutput\na,"你好,朋友",你好\nb,退款,解释退款流程\n',
          };
          const preview = await app.inject({
            method: "POST",
            url: `/v1/datasets/${dataset.id}/import-preview`,
            payload: input,
          });
          expect(preview.statusCode).toBe(200);
          expect(await service.listVersions(dataset.id)).toEqual([]);
          const previewHash = objectResponse(preview).previewHash;
          if (typeof previewHash !== "string") throw new Error("Missing preview hash");
          const payload = { ...input, previewHash };
          const saved = await app.inject({
            method: "POST",
            url: `/v1/datasets/${dataset.id}/import`,
            payload,
          });
          expect(saved.statusCode).toBe(201);
          const version = objectResponse(saved);
          expect(version).toMatchObject({
            status: "draft",
            source: "imported",
            caseCount: 2,
            publishedAt: null,
            generationProvenance: { sourceHash: payload.previewHash, format: "csv", rowCount: 2 },
          });
          if (typeof version.id !== "string") throw new Error("Missing saved version ID");
          const cases = await service.listCases(version.id);
          expect(cases.map((item) => item.input)).toEqual(["你好,朋友", "退款"]);
          expect(cases[0]?.expectedOutput).toBe("你好");
          const duplicate = await app.inject({
            method: "POST",
            url: `/v1/datasets/${dataset.id}/import`,
            payload,
          });
          expect(duplicate.statusCode).toBe(409);
          const invalid = await app.inject({
            method: "POST",
            url: `/v1/datasets/${dataset.id}/import`,
            payload: {
              format: "json",
              content: '[{"input":"good"},{"input":null}]',
              previewHash: payload.previewHash,
            },
          });
          expect(invalid.statusCode).toBe(422);
          expect(await service.listVersions(dataset.id)).toHaveLength(1);
        } finally {
          await app.close();
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 30_000);
});
