import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient, type RepositoryDatabase } from "../client.js";
import { loadDatabaseConfig } from "../config.js";
import {
  projects,
  prompts,
  promptVersions,
  evaluationFrameworks,
  evaluationFrameworkVersions,
  datasets,
  datasetVersions,
  evaluationCases,
  experiments,
  generationRuns,
  evaluationRuns,
  evaluationRunDispatches,
  ablationExperiments,
  type PromptBlock,
} from "../schema.js";
import { hashVersionContent } from "../versioning.js";
import { createAblationRepository } from "./ablations.js";
import { createExperimentRepository } from "./experiments.js";
import { createPromptRepository } from "./prompts.js";

// Explicit disposable test database only; never read a developer's .env or pay a provider.
describe.skipIf(!process.env.TEST_DATABASE_URL)("ablation PostgreSQL transactions", () => {
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

  async function isolated(
    test: (tx: RepositoryDatabase, fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
  ) {
    const rollback = new Error("rollback test fixture");
    try {
      await client.db.transaction(async (tx) => {
        await test(tx, await seed(tx));
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  it("pins source settings, publishes only the variant and atomically records two outbox jobs", async () => {
    await isolated(async (tx, fixture) => {
      const repository = createAblationRepository(tx);
      const link = await repository.create(fixture.input);
      const repeated = await repository.create(fixture.input);
      expect(repeated.id).toBe(link.id);
      const [experiment] = await tx
        .select()
        .from(experiments)
        .where(eq(experiments.id, link.experimentId));
      expect(experiment).toMatchObject({
        status: "queued",
        datasetVersionId: fixture.datasetVersionId,
        frameworkVersionId: fixture.frameworkVersionId,
        randomSeed: 42,
        repetitions: 1,
      });
      const [variant] = await tx
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.id, link.variantPromptVersionId));
      expect(variant).toMatchObject({
        status: "published",
        parentVersionId: fixture.input.candidatePromptVersionId,
      });
      expect(variant?.blocks[0]?.content).toBe("old 0");
      expect(variant?.blocks[1]?.content).toBe("new 1");
      const [candidate] = await tx
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.id, fixture.input.candidatePromptVersionId));
      expect(candidate?.blocks[0]?.content).toBe("new 0");
      const generation = await tx
        .select()
        .from(generationRuns)
        .where(eq(generationRuns.experimentId, link.experimentId));
      expect(generation).toHaveLength(2);
      expect(
        generation.every(
          (run) =>
            run.model === "test-model" &&
            run.modelConfig.temperature === 0.2 &&
            run.repetition === 1,
        ),
      ).toBe(true);
      const evaluations = await tx
        .select()
        .from(evaluationRuns)
        .where(eq(evaluationRuns.experimentId, link.experimentId));
      expect(evaluations.every((run) => run.evaluatorConfig.model === "test-judge")).toBe(true);
      const outbox = await tx
        .select()
        .from(evaluationRunDispatches)
        .where(
          inArray(
            evaluationRunDispatches.evaluationRunId,
            evaluations.map((run) => run.id),
          ),
        );
      expect(outbox).toHaveLength(2);
      expect(await repository.list(randomUUID(), fixture.input.sourceExperimentId)).toEqual([]);
      await expect(
        repository.create({ ...fixture.input, projectId: randomUUID() }),
      ).rejects.toThrow("not found");
    });
  });

  it("limits new interventions but still returns existing ones at the limit", async () => {
    await isolated(async (tx, fixture) => {
      const repository = createAblationRepository(tx);
      for (let i = 0; i < 5; i += 1)
        await repository.create({ ...fixture.input, blockId: `block${i}` });
      await expect(repository.create({ ...fixture.input, blockId: "block5" })).rejects.toThrow(
        "At most five",
      );
      expect((await repository.create(fixture.input)).revertedBlockId).toBe("block0");
      expect(
        await repository.list(fixture.input.projectId, fixture.input.sourceExperimentId),
      ).toHaveLength(5);
    });
  });

  it("serializes concurrent duplicate requests without creating duplicate paid jobs", async () => {
    const fixture = await seed(client.db);
    try {
      const repository = createAblationRepository(client.db);
      const links = await Promise.all(
        Array.from({ length: 4 }, () => repository.create(fixture.input)),
      );
      expect(new Set(links.map((link) => link.id)).size).toBe(1);
      const experimentId = links[0]?.experimentId;
      if (!experimentId) throw new Error("Missing intervention experiment");
      expect(
        await client.db
          .select()
          .from(generationRuns)
          .where(eq(generationRuns.experimentId, experimentId)),
      ).toHaveLength(2);
      expect(
        await repository.list(fixture.input.projectId, fixture.input.sourceExperimentId),
      ).toHaveLength(1);
    } finally {
      // Remove only this test's generated rows, in foreign-key order.
      await client.db.transaction(async (tx) => {
        await tx
          .delete(ablationExperiments)
          .where(eq(ablationExperiments.sourceExperimentId, fixture.input.sourceExperimentId));
        await tx.delete(experiments).where(eq(experiments.projectId, fixture.input.projectId));
        await tx.delete(projects).where(eq(projects.id, fixture.input.projectId));
      });
    }
  });

  it("rolls back a new published variant if queuing fails and refuses changed evaluator settings", async () => {
    await isolated(async (tx, fixture) => {
      const repository = createAblationRepository(tx);
      await tx
        .update(evaluationFrameworkVersions)
        .set({ status: "archived" })
        .where(eq(evaluationFrameworkVersions.id, fixture.frameworkVersionId));
      await expect(repository.create(fixture.input)).rejects.toThrow("not found");
      expect(
        await tx.select().from(promptVersions).where(eq(promptVersions.promptId, fixture.promptId)),
      ).toHaveLength(2);
      expect(
        await tx
          .select()
          .from(ablationExperiments)
          .where(eq(ablationExperiments.sourceExperimentId, fixture.input.sourceExperimentId)),
      ).toHaveLength(0);
      await tx
        .update(evaluationFrameworkVersions)
        .set({ status: "published" })
        .where(eq(evaluationFrameworkVersions.id, fixture.frameworkVersionId));
      await tx
        .update(evaluationRuns)
        .set({ evaluatorVersion: "unsupported" })
        .where(eq(evaluationRuns.experimentId, fixture.input.sourceExperimentId));
      await expect(repository.create(fixture.input)).rejects.toThrow("identical settings");
    });
  });
});

async function seed(tx: RepositoryDatabase) {
  const projectId = randomUUID(),
    promptId = randomUUID(),
    datasetId = randomUUID();
  const datasetVersionId = randomUUID(),
    frameworkId = randomUUID(),
    frameworkVersionId = randomUUID();
  await tx
    .insert(projects)
    .values({ id: projectId, slug: `test-${projectId}`, name: "Transaction test" });
  await tx
    .insert(prompts)
    .values({ id: promptId, projectId, key: "test-prompt", name: "Test Prompt" });
  const promptRepo = createPromptRepository(tx);
  const blocks = (prefix: string): PromptBlock[] =>
    Array.from({ length: 6 }, (_, i) => ({
      id: `block${i}`,
      kind: "policy",
      name: `Block ${i}`,
      content: `${prefix} ${i}`,
    }));
  const baseline = await promptRepo.publishVersion(
    (await promptRepo.createVersion(promptId, { blocks: blocks("old") })).id,
  );
  const candidate = await promptRepo.publishVersion(
    (await promptRepo.createVersion(promptId, { blocks: blocks("new") })).id,
  );
  await tx
    .insert(evaluationFrameworks)
    .values({ id: frameworkId, projectId, key: "test-framework", name: "Test framework" });
  await tx.insert(evaluationFrameworkVersions).values({
    id: frameworkVersionId,
    frameworkId,
    version: 1,
    status: "published",
    contentHash: hashVersionContent({ test: true }),
    definition: { levels: [], dimensions: [] },
  });
  await tx
    .insert(datasets)
    .values({ id: datasetId, projectId, key: "test-dataset", name: "Test dataset" });
  await tx.insert(datasetVersions).values({
    id: datasetVersionId,
    datasetId,
    version: 1,
    status: "published",
    caseCount: 1,
    contentHash: hashVersionContent({ test: true }),
  });
  await tx.insert(evaluationCases).values({
    datasetVersionId,
    caseKey: "case1",
    input: { question: "test" },
    contentHash: hashVersionContent({ question: "test" }),
  });
  const experimentRepo = createExperimentRepository(tx);
  const source = await experimentRepo.create({
    projectId,
    datasetVersionId,
    frameworkVersionId,
    name: "Test source",
    randomSeed: 42,
    promptVersions: [
      { promptVersionId: baseline.id, label: "baseline", isBaseline: true },
      { promptVersionId: candidate.id, label: "candidate", isBaseline: false },
    ],
  });
  await experimentRepo.start({
    projectId,
    experimentId: source.id,
    provider: "openai-compatible",
    model: "test-model",
    modelConfig: { temperature: 0.2 },
    evaluatorModel: "test-judge",
  });
  // Simulate completed source runs only; new intervention runs must remain queued.
  await tx
    .update(generationRuns)
    .set({ status: "succeeded" })
    .where(eq(generationRuns.experimentId, source.id));
  await tx
    .update(evaluationRuns)
    .set({ status: "succeeded" })
    .where(eq(evaluationRuns.experimentId, source.id));
  return {
    promptId,
    datasetVersionId,
    frameworkVersionId,
    input: {
      projectId,
      sourceExperimentId: source.id,
      candidatePromptVersionId: candidate.id,
      blockId: "block0",
    },
  };
}
