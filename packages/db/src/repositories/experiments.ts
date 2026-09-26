import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../client.js";
import { EntityNotFoundError } from "../errors.js";
import {
  datasets,
  datasetVersions,
  evaluationFrameworks,
  evaluationFrameworkVersions,
  experimentPromptVersions,
  experiments,
  projects,
  prompts,
  promptVersions,
  type JsonValue,
} from "../schema.js";
import { stableStringify } from "../versioning.js";
import { normalizeDescription } from "./common.js";

export interface ExperimentPromptVersionInput {
  readonly promptVersionId: string;
  readonly label: string;
  readonly isBaseline: boolean;
}

export interface CreateExperimentInput {
  readonly projectId: string;
  readonly datasetVersionId: string;
  readonly frameworkVersionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly randomSeed: number;
  readonly repetitions?: number;
  readonly config?: Record<string, JsonValue>;
  readonly promptVersions: readonly ExperimentPromptVersionInput[];
  readonly createdBy?: string | null;
}

export interface ExperimentRepository {
  create(input: CreateExperimentInput): Promise<typeof experiments.$inferSelect>;
}

/**
 * Creates a reproducible comparison plan. Every referenced version must be
 * published and belong to the same project, so an experiment cannot silently
 * mix unrelated tests, rubrics, or Prompts.
 */
export function createExperimentRepository(db: Database): ExperimentRepository {
  return {
    async create(input) {
      const normalized = normalizeCreateExperiment(input);
      return db.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, normalized.projectId))
          .limit(1);
        if (!project) throw new EntityNotFoundError("Project", normalized.projectId);

        const [datasetVersion] = await tx
          .select({ id: datasetVersions.id })
          .from(datasetVersions)
          .innerJoin(datasets, eq(datasetVersions.datasetId, datasets.id))
          .where(
            and(
              eq(datasetVersions.id, normalized.datasetVersionId),
              eq(datasets.projectId, normalized.projectId),
              eq(datasetVersions.status, "published"),
            ),
          )
          .limit(1);
        if (!datasetVersion) {
          throw new EntityNotFoundError("Published dataset version", normalized.datasetVersionId);
        }

        const [frameworkVersion] = await tx
          .select({ id: evaluationFrameworkVersions.id })
          .from(evaluationFrameworkVersions)
          .innerJoin(
            evaluationFrameworks,
            eq(evaluationFrameworkVersions.frameworkId, evaluationFrameworks.id),
          )
          .where(
            and(
              eq(evaluationFrameworkVersions.id, normalized.frameworkVersionId),
              eq(evaluationFrameworks.projectId, normalized.projectId),
              eq(evaluationFrameworkVersions.status, "published"),
            ),
          )
          .limit(1);
        if (!frameworkVersion) {
          throw new EntityNotFoundError("Published evaluation framework version", normalized.frameworkVersionId);
        }

        const selectedPromptVersions = await tx
          .select({ id: promptVersions.id })
          .from(promptVersions)
          .innerJoin(prompts, eq(promptVersions.promptId, prompts.id))
          .where(
            and(
              inArray(
                promptVersions.id,
                normalized.promptVersions.map((promptVersion) => promptVersion.promptVersionId),
              ),
              eq(prompts.projectId, normalized.projectId),
              eq(promptVersions.status, "published"),
            ),
          );
        if (selectedPromptVersions.length !== normalized.promptVersions.length) {
          throw new EntityNotFoundError("Published prompt version", "one or more requested versions");
        }

        const [created] = await tx
          .insert(experiments)
          .values({
            projectId: normalized.projectId,
            datasetVersionId: normalized.datasetVersionId,
            frameworkVersionId: normalized.frameworkVersionId,
            name: normalized.name,
            description: normalized.description,
            randomSeed: normalized.randomSeed,
            repetitions: normalized.repetitions,
            config: normalized.config,
            createdBy: normalized.createdBy,
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the created experiment");

        await tx.insert(experimentPromptVersions).values(
          normalized.promptVersions.map((promptVersion) => ({
            experimentId: created.id,
            promptVersionId: promptVersion.promptVersionId,
            label: promptVersion.label,
            isBaseline: promptVersion.isBaseline,
          })),
        );
        return created;
      });
    },
  };
}

export function normalizeCreateExperiment(input: CreateExperimentInput) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 240) {
    throw new TypeError("experiment name must be 2-240 characters");
  }
  if (!Number.isSafeInteger(input.randomSeed)) {
    throw new TypeError("randomSeed must be a safe integer");
  }
  const repetitions = input.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new TypeError("repetitions must be an integer between 1 and 100");
  }
  const config = input.config ?? {};
  stableStringify(config);
  const promptVersions = normalizePromptVersions(input.promptVersions);
  const createdBy = normalizeActor(input.createdBy);
  return {
    projectId: input.projectId,
    datasetVersionId: input.datasetVersionId,
    frameworkVersionId: input.frameworkVersionId,
    name,
    description: normalizeDescription(input.description),
    randomSeed: input.randomSeed,
    repetitions,
    config,
    promptVersions,
    createdBy,
  };
}

function normalizePromptVersions(input: readonly ExperimentPromptVersionInput[]) {
  if (input.length === 0 || input.length > 20) {
    throw new TypeError("an experiment must compare 1-20 prompt versions");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  let baselineCount = 0;
  const result = input.map((item) => {
    const id = item.promptVersionId.trim();
    const label = item.label.trim();
    if (id.length === 0) throw new TypeError("promptVersionId is required");
    if (label.length === 0 || label.length > 120) {
      throw new TypeError("prompt version label must be 1-120 characters");
    }
    if (ids.has(id)) throw new TypeError("a prompt version may be included only once");
    if (labels.has(label)) throw new TypeError("prompt version labels must be unique");
    if (typeof item.isBaseline !== "boolean") throw new TypeError("isBaseline must be boolean");
    ids.add(id);
    labels.add(label);
    if (item.isBaseline) baselineCount += 1;
    return { promptVersionId: id, label, isBaseline: item.isBaseline };
  });
  if (baselineCount !== 1) throw new TypeError("an experiment must have exactly one baseline");
  return result;
}

function normalizeActor(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 255) throw new TypeError("createdBy must be at most 255 characters");
  return normalized;
}
