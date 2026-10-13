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
  projects,
  prompts,
  type PromptBlock,
} from "../schema.js";
import { hashVersionContent } from "../versioning.js";
import { createEvaluationRepository } from "./evaluations.js";
import { createExperimentRepository } from "./experiments.js";
import { createPromptRepository } from "./prompts.js";

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
    return { projectId, first, second, repository, start };
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
});
