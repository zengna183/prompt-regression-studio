import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../client.js";
import { loadDatabaseConfig } from "../config.js";
import {
  datasets,
  datasetVersions,
  evaluationCases,
  evaluationFrameworks,
  evaluationFrameworkVersions,
  evaluationRuns,
  experiments,
  generationRuns,
  generationOutputs,
  scores,
  projects,
  prompts,
  type PromptBlock,
} from "../schema.js";
import { hashVersionContent } from "../versioning.js";
import { createEvaluationRepository } from "./evaluations.js";
import { createExperimentRepository } from "./experiments.js";
import { createExperimentCaseRepository } from "./experiment-cases.js";
import { createPromptRepository } from "./prompts.js";
import { createModelConnectionRepository } from "./model-connections.js";

// These tests only run against an explicitly supplied disposable PostgreSQL database.
describe.skipIf(!process.env.TEST_DATABASE_URL)("experiment execution controls", () => {
  let client: DatabaseClient;
  beforeAll(async () => {
    client = createDatabaseClient(
      loadDatabaseConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  async function fixture() {
    const projectId = randomUUID();
    const promptId = randomUUID();
    const datasetId = randomUUID();
    const frameworkId = randomUUID();
    const datasetVersionId = randomUUID();
    const frameworkVersionId = randomUUID();
    await client.db
      .insert(projects)
      .values({ id: projectId, slug: `controls-${projectId}`, name: "Execution controls" });
    await client.db
      .insert(prompts)
      .values({ id: promptId, projectId, key: "prompt", name: "Test prompt" });
    const blocks: PromptBlock[] = [
      { id: "system", kind: "policy", name: "System", content: "Answer briefly" },
    ];
    const promptRepo = createPromptRepository(client.db);
    const promptVersion = await promptRepo.publishVersion(
      (await promptRepo.createVersion(promptId, { blocks })).id,
    );
    await client.db
      .insert(datasets)
      .values({ id: datasetId, projectId, key: "dataset", name: "Test dataset" });
    await client.db.insert(datasetVersions).values({
      id: datasetVersionId,
      datasetId,
      version: 1,
      status: "published",
      caseCount: 1,
      contentHash: hashVersionContent({ datasetVersionId }),
    });
    await client.db.insert(evaluationCases).values({
      datasetVersionId,
      caseKey: "one",
      input: { question: "hello" },
      contentHash: hashVersionContent({ question: "hello" }),
    });
    await client.db
      .insert(evaluationFrameworks)
      .values({ id: frameworkId, projectId, key: "rubric", name: "Test rubric" });
    await client.db.insert(evaluationFrameworkVersions).values({
      id: frameworkVersionId,
      frameworkId,
      version: 1,
      status: "published",
      contentHash: hashVersionContent({ frameworkVersionId }),
      definition: { levels: [], dimensions: [] },
    });
    const repository = createExperimentRepository(client.db, { maxActiveExperimentsPerProject: 1 });
    const create = (name: string) =>
      repository.create({
        projectId,
        datasetVersionId,
        frameworkVersionId,
        name,
        randomSeed: 42,
        promptVersions: [
          { promptVersionId: promptVersion.id, label: "baseline", isBaseline: true },
        ],
      });
    const first = await create("First experiment");
    const second = await create("Second experiment");
    const start = (experimentId: string) =>
      repository.start({
        projectId,
        experimentId,
        provider: "openai-compatible",
        model: "test-model",
        costBudget: {
          maxUsd: 0.01,
          generationInputUsdPerMillionTokens: 1,
          generationOutputUsdPerMillionTokens: 2,
          evaluatorInputUsdPerMillionTokens: 1,
          evaluatorOutputUsdPerMillionTokens: 2,
        },
      });
    return { projectId, first, second, repository, start, datasetVersionId };
  }

  async function isolated(test: (data: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const data = await fixture();
    try {
      await test(data);
    } finally {
      await client.db.delete(experiments).where(eq(experiments.projectId, data.projectId));
      await client.db.delete(projects).where(eq(projects.id, data.projectId));
    }
  }

  it("pages evidence without dropping missing/failed answers or disclosing raw provider data", async () => {
    await isolated(async ({ projectId, first, start, datasetVersionId }) => {
      for (let i = 1; i <= 2; i++)
        await client.db.insert(evaluationCases).values({
          datasetVersionId,
          caseKey: `extra-${i}`,
          input: `question-${i}`,
          sortOrder: i,
          contentHash: hashVersionContent({ i }),
        });
      await client.db
        .update(datasetVersions)
        .set({ caseCount: 3 })
        .where(eq(datasetVersions.id, datasetVersionId));
      const reader = createExperimentCaseRepository(client.db);
      const query = { offset: 0, limit: 2, repetition: 1 };
      const before = await reader.list(projectId, first.id, query);
      expect(before?.total).toBe(3);
      expect(before?.items).toHaveLength(2);
      expect(
        before?.items.every((item) =>
          item.results.every((r) => r.output === null && r.scores.length === 0),
        ),
      ).toBe(true);
      expect(await reader.list(randomUUID(), first.id, query)).toBeNull();
      await expect(reader.list(projectId, first.id, { ...query, repetition: 2 })).rejects.toThrow(
        "not part",
      );
      await start(first.id);
      const [run] = await client.db
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.experimentId, first.id));
      const firstCase = before!.items[0]!;
      const secondCase = before!.items[1]!;
      await client.db.insert(generationOutputs).values({
        generationRunId: run!.generationRunId,
        caseId: firstCase.caseId,
        status: "failed",
        errorCode: "PROVIDER_TIMEOUT",
        errorMessage: "Timed out",
        request: { secret: "must-not-disclose" },
        rawResponse: { private: "must-not-disclose" },
      });
      const [output] = await client.db
        .insert(generationOutputs)
        .values({
          generationRunId: run!.generationRunId,
          caseId: secondCase.caseId,
          status: "succeeded",
          outputText: "an answer",
        })
        .returning();
      await client.db.insert(scores).values({
        evaluationRunId: run!.id,
        generationOutputId: output!.id,
        kind: "overall",
        metricKey: "__overall__",
        score: 0,
        minScore: 0,
        maxScore: 1,
        normalizedScore: 0,
        passed: false,
        rationale: "Wrong answer",
        evidence: ["an answer"],
        rawResult: { secret: "must-not-disclose" },
      });
      const after = await reader.list(projectId, first.id, query);
      expect(after?.items[0]?.results[0]?.output?.errorCode).toBe("PROVIDER_TIMEOUT");
      expect(after?.items[0]?.results[0]?.scores).toEqual([]);
      expect(after?.items[1]?.results[0]?.scores[0]).toMatchObject({
        normalizedScore: 0,
        rationale: "Wrong answer",
        metricName: "综合分",
      });
      expect(JSON.stringify(after)).not.toMatch(
        /must-not-disclose|rawResponse|rawResult|"request"/u,
      );
      const last = await reader.list(projectId, first.id, { ...query, offset: 2 });
      expect(last?.items).toHaveLength(1);
      expect(last?.items[0]?.results[0]?.output).toBeNull();
      expect(new Set([...after!.items, ...last!.items].map((item) => item.caseId)).size).toBe(3);
      expect((await reader.list(projectId, first.id, { ...query, offset: 3 }))?.items).toEqual([]);
    });
  });

  it("serializes project admission and permits a new start after cancellation", async () => {
    await isolated(async ({ projectId, first, second, repository, start }) => {
      const outcomes = await Promise.allSettled([start(first.id), start(second.id)]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const activeId = outcomes[0]?.status === "fulfilled" ? first.id : second.id;
      const waitingId = activeId === first.id ? second.id : first.id;
      await repository.cancel(projectId, activeId);
      expect((await start(waitingId)).experiment.status).toBe("queued");
    });
  });

  it("cancels running children and prevents their completion from reviving the experiment", async () => {
    await isolated(async ({ projectId, first, repository, start }) => {
      const started = await start(first.id);
      const runId = started.evaluationRunIds[0];
      if (!runId) throw new Error("Missing run");
      const evaluations = createEvaluationRepository(client.db);
      const claimed = await evaluations.claimEvaluation(runId);
      expect(claimed?.status).toBe("running");
      await evaluations.startGenerationRun(claimed!.generationRunId);
      expect((await repository.cancel(projectId, first.id)).status).toBe("cancelled");
      expect((await repository.cancel(projectId, first.id)).status).toBe("cancelled");
      expect(await evaluations.isCancelled(runId)).toBe(true);
      expect(await evaluations.claimEvaluation(runId)).toBeNull();
      expect(
        (
          await evaluations.completeGenerationRun(claimed!.generationRunId, {
            succeededCount: 1,
            failedCount: 0,
          })
        ).status,
      ).toBe("cancelled");
      expect(
        (await evaluations.completeEvaluationRun(runId, { succeededCount: 1, failedCount: 0 }))
          .status,
      ).toBe("cancelled");
      expect((await repository.getDetail(projectId, first.id))?.experiment.status).toBe(
        "cancelled",
      );
      const [generation] = await client.db
        .select()
        .from(generationRuns)
        .where(eq(generationRuns.id, claimed!.generationRunId));
      const [evaluation] = await client.db
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.id, runId));
      expect(generation?.status).toBe("cancelled");
      expect(evaluation?.status).toBe("cancelled");
    });
  });

  it("atomically reserves estimated cost across competing workers", async () => {
    await isolated(async ({ first, start }) => {
      const started = await start(first.id);
      const runId = started.evaluationRunIds[0];
      if (!runId) throw new Error("Missing run");
      const evaluations = createEvaluationRepository(client.db);
      const request = {
        evaluationRunId: runId,
        phase: "generation" as const,
        requestBytes: 1_000,
        maxOutputTokens: 2_000,
      };
      const outcomes = await Promise.allSettled([
        evaluations.reserveModelCall(request),
        evaluations.reserveModelCall(request),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const [experiment] = await client.db
        .select()
        .from(experiments)
        .where(eq(experiments.id, first.id));
      expect(experiment?.costReservedUsd).toBe(0.005512);
    });
  });

  it("pins project-scoped encrypted model connections to both runs", async () => {
    await isolated(async ({ projectId, first, repository }) => {
      const connections = createModelConnectionRepository(client.db, Buffer.alloc(32, 7));
      const generation = await connections.create({
        projectId,
        name: "Generator",
        baseUrl: "https://models.example.com",
        allowedModels: ["generator-model"],
        apiKey: "generator-secret-key",
        supportsSeed: true,
      });
      const judge = await connections.create({
        projectId,
        name: "Judge",
        baseUrl: "https://judge.example.com",
        allowedModels: ["judge-model"],
        apiKey: "judge-secret-key",
        supportsSeed: false,
      });
      expect(JSON.stringify(generation)).not.toContain("generator-secret-key");
      expect((await connections.resolve(projectId, generation.id))?.apiKey).toBe(
        "generator-secret-key",
      );
      expect(await connections.resolve(randomUUID(), generation.id)).toBeNull();
      await expect(
        repository.start({
          projectId,
          experimentId: first.id,
          provider: "openai-compatible",
          model: "wrong-model",
          modelConnectionId: generation.id,
        }),
      ).rejects.toMatchObject({ code: "MODEL_CONNECTION_UNAVAILABLE" });
      const started = await repository.start({
        projectId,
        experimentId: first.id,
        provider: "openai-compatible",
        model: "generator-model",
        modelConnectionId: generation.id,
        evaluatorModel: "judge-model",
        evaluatorConnectionId: judge.id,
      });
      const [run] = await client.db
        .select({
          generationConnectionId: generationRuns.modelConnectionId,
          judgeConnectionId: evaluationRuns.modelConnectionId,
        })
        .from(evaluationRuns)
        .innerJoin(generationRuns, eq(evaluationRuns.generationRunId, generationRuns.id))
        .where(eq(evaluationRuns.id, started.evaluationRunIds[0]!));
      expect(run).toEqual({ generationConnectionId: generation.id, judgeConnectionId: judge.id });
      await connections.disable(projectId, generation.id);
      expect(await connections.resolve(projectId, generation.id)).toBeNull();
      expect((await connections.rotate(projectId, judge.id, "rotated-judge-key")).id).toBe(
        judge.id,
      );
      expect((await connections.resolve(projectId, judge.id))?.apiKey).toBe("rotated-judge-key");
    });
  });
});
