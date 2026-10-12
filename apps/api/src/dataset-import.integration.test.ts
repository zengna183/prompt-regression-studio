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
import { createDatasetCaseGenerator } from "./dataset-generation.js";

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
          datasetCaseGenerator: createDatasetCaseGenerator(
            {
              complete: () =>
                Promise.resolve({
                  provider: "openai-compatible" as const,
                  model: "fixture-model",
                  text: JSON.stringify({
                    cases: [
                      {
                        name: "超期退款",
                        input: "已经超期，还能退款吗？",
                        expectedOutput: "核实政策后回答，不要擅自承诺",
                      },
                    ],
                  }),
                  usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
                  providerRequestId: "fixture-request",
                  rawResponse: null,
                }),
            },
            "fixture-model",
          ),
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
          const blockedImport = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${version.id}/publish`,
          });
          expect(blockedImport.statusCode).toBe(409);
          expect(blockedImport.json()).toMatchObject({ code: "DATASET_REVIEW_REQUIRED" });
          const generated = await app.inject({
            method: "POST",
            url: `/v1/datasets/${dataset.id}/generate`,
            payload: { brief: "测试客服对超期退款申请的回答质量", count: 1 },
          });
          expect(generated.statusCode).toBe(201);
          const aiVersion = objectResponse(generated);
          expect(aiVersion).toMatchObject({
            status: "draft",
            source: "ai_generated",
            caseCount: 1,
            generationProvenance: {
              model: "fixture-model",
              brief: "测试客服对超期退款申请的回答质量",
              providerRequestId: "fixture-request",
            },
          });
          if (typeof aiVersion.id !== "string") throw new Error("Missing AI version ID");
          expect((await service.listCases(aiVersion.id))[0]?.input).toBe("已经超期，还能退款吗？");
          const blockedAi = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${aiVersion.id}/publish`,
          });
          expect(blockedAi.statusCode).toBe(409);
          expect(blockedAi.json()).toMatchObject({ code: "DATASET_REVIEW_REQUIRED" });
          const editedCases = (await service.listCases(version.id)).map((item) => ({
            caseKey: item.caseKey,
            ...(item.name ? { name: item.name } : {}),
            input: item.input,
            ...(item.expectedOutput === null ? {} : { expectedOutput: item.expectedOutput }),
            metadata: item.metadata,
          }));
          const firstEdited = editedCases[0];
          if (!firstEdited) throw new Error("Missing import case");
          editedCases[0] = { ...firstEdited, expectedOutput: "人工核对后的问候" };
          const reviewed = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${version.id}/review`,
            payload: {
              cases: editedCases,
              reviewerName: "测试审核人",
              reviewNotes: "已逐条核对并修改参考回答",
              acknowledged: true,
            },
          });
          expect(reviewed.statusCode).toBe(200);
          const reviewedVersion = objectResponse(reviewed);
          expect(reviewedVersion).toMatchObject({
            status: "draft",
            source: "mixed",
            parentVersionId: version.id,
            reviewedBy: "测试审核人",
            reviewNotes: "已逐条核对并修改参考回答",
          });
          if (typeof reviewedVersion.id !== "string")
            throw new Error("Missing reviewed version ID");
          expect(reviewedVersion.id).not.toBe(version.id);
          expect((await service.listCases(version.id))[0]?.expectedOutput).toBe("你好");
          expect((await service.listCases(reviewedVersion.id))[0]?.expectedOutput).toBe(
            "人工核对后的问候",
          );
          const sameReview = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${reviewedVersion.id}/review`,
            payload: {
              cases: editedCases,
              reviewerName: "测试审核人",
              reviewNotes: "已逐条核对并修改参考回答",
              acknowledged: true,
            },
          });
          expect(sameReview.statusCode).toBe(200);
          expect(objectResponse(sameReview).id).toBe(reviewedVersion.id);
          const changedReviewRecord = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${reviewedVersion.id}/review`,
            payload: {
              cases: editedCases,
              reviewerName: "其他审核人",
              acknowledged: true,
            },
          });
          expect(changedReviewRecord.statusCode).toBe(409);
          expect(changedReviewRecord.json()).toMatchObject({ code: "DATASET_ALREADY_REVIEWED" });
          const published = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${reviewedVersion.id}/publish`,
          });
          expect(published.statusCode).toBe(200);
          expect(published.json()).toMatchObject({ status: "published", reviewedBy: "测试审核人" });
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/v1/dataset-versions/${reviewedVersion.id}/review`,
                payload: { cases: editedCases, reviewerName: "测试审核人", acknowledged: true },
              })
            ).statusCode,
          ).toBe(409);

          const acceptedAiCases = (await service.listCases(aiVersion.id)).map((item) => ({
            caseKey: item.caseKey,
            ...(item.name ? { name: item.name } : {}),
            input: item.input,
            ...(item.expectedOutput === null ? {} : { expectedOutput: item.expectedOutput }),
            metadata: item.metadata,
          }));
          const acceptedAi = await app.inject({
            method: "POST",
            url: `/v1/dataset-versions/${aiVersion.id}/review`,
            payload: { cases: acceptedAiCases, reviewerName: "测试审核人", acknowledged: true },
          });
          expect(acceptedAi.statusCode).toBe(200);
          expect(acceptedAi.json()).toMatchObject({
            id: aiVersion.id,
            source: "ai_generated",
            reviewedBy: "测试审核人",
          });
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/v1/dataset-versions/${aiVersion.id}/publish`,
              })
            ).statusCode,
          ).toBe(200);
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
