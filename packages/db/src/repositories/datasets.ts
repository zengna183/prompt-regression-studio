import { and, asc, desc, eq, max, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  EntityNotFoundError,
  InvalidVersionStateError,
  RepositoryConflictError,
} from "../errors.js";
import {
  datasets,
  datasetVersions,
  evaluationCases,
  type Dataset,
  type DatasetVersion,
  type EvaluationCase,
  type JsonValue,
} from "../schema.js";
import {
  hashVersionContent,
  nextVersionNumber,
  stableStringify,
  VersionContentError,
} from "../versioning.js";
import {
  mapUniqueViolation,
  normalizeChangeSummary,
  normalizeDescription,
  normalizeKey,
  normalizeName,
} from "./common.js";

export type DatasetSource = "manual" | "ai_generated" | "imported" | "mixed";

export interface CreateDatasetInput {
  readonly projectId: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface EvaluationCaseInput {
  readonly caseKey: string;
  readonly name?: string | null;
  readonly input: JsonValue;
  readonly expectedOutput?: JsonValue | null;
  readonly metadata?: Record<string, JsonValue>;
}

export interface CreateDatasetVersionInput {
  readonly source?: DatasetSource;
  readonly cases: readonly EvaluationCaseInput[];
  readonly generationProvenance?: JsonValue | null;
  /** Undefined links to the latest version; null explicitly creates a new root. */
  readonly parentVersionId?: string | null;
  readonly changeSummary?: string | null;
  readonly createdBy?: string | null;
}

export interface NormalizedEvaluationCase {
  readonly caseKey: string;
  readonly name: string | null;
  readonly input: JsonValue;
  readonly expectedOutput: JsonValue | null;
  readonly metadata: Record<string, JsonValue>;
  readonly contentHash: string;
  readonly sortOrder: number;
}

export interface DatasetRepository {
  create(input: CreateDatasetInput): Promise<Dataset>;
  listByProject(projectId: string): Promise<Dataset[]>;
  createVersion(datasetId: string, input: CreateDatasetVersionInput): Promise<DatasetVersion>;
  listVersions(datasetId: string): Promise<DatasetVersion[]>;
  getVersionById(id: string): Promise<DatasetVersion | null>;
  listCases(versionId: string): Promise<EvaluationCase[]>;
  publishVersion(id: string): Promise<DatasetVersion>;
}

const caseKeyPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,119})$/u;
const datasetSources = new Set<DatasetSource>(["manual", "ai_generated", "imported", "mixed"]);

export function createDatasetRepository(db: Database): DatasetRepository {
  return {
    async create(input) {
      try {
        const [created] = await db
          .insert(datasets)
          .values({
            projectId: input.projectId,
            key: normalizeKey(input.key, "dataset key"),
            name: normalizeName(input.name, "dataset name"),
            description: normalizeDescription(input.description),
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the created dataset");
        return created;
      } catch (error) {
        mapUniqueViolation(
          error,
          "DATASET_KEY_EXISTS",
          `Dataset key already exists in this project: ${input.key}`,
        );
      }
    },

    async listByProject(projectId) {
      return db
        .select()
        .from(datasets)
        .where(eq(datasets.projectId, projectId))
        .orderBy(asc(datasets.createdAt), asc(datasets.id));
    },

    async createVersion(datasetId, input) {
      const source = normalizeDatasetSource(input.source);
      const cases = normalizeEvaluationCases(input.cases);
      const contentHash = hashDatasetCases(cases);
      const provenance = normalizeProvenance(input.generationProvenance);

      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`select ${datasets.id} from ${datasets} where ${datasets.id} = ${datasetId} for update`,
          );
          const [dataset] = await tx
            .select()
            .from(datasets)
            .where(eq(datasets.id, datasetId))
            .limit(1);
          if (!dataset) throw new EntityNotFoundError("Dataset", datasetId);
          if (dataset.archivedAt) {
            throw new RepositoryConflictError(
              "DATASET_ARCHIVED",
              "Cannot create a version for an archived dataset",
            );
          }

          const [latest] = await tx
            .select({ id: datasetVersions.id, version: datasetVersions.version })
            .from(datasetVersions)
            .where(eq(datasetVersions.datasetId, datasetId))
            .orderBy(desc(datasetVersions.version))
            .limit(1);
          const [aggregate] = await tx
            .select({ maximum: max(datasetVersions.version) })
            .from(datasetVersions)
            .where(eq(datasetVersions.datasetId, datasetId));
          const version = nextVersionNumber(
            aggregate?.maximum === null || aggregate?.maximum === undefined
              ? null
              : Number(aggregate.maximum),
          );

          const parentVersionId =
            input.parentVersionId === undefined ? (latest?.id ?? null) : input.parentVersionId;
          if (parentVersionId !== null) {
            const [parent] = await tx
              .select({ id: datasetVersions.id })
              .from(datasetVersions)
              .where(
                and(
                  eq(datasetVersions.id, parentVersionId),
                  eq(datasetVersions.datasetId, datasetId),
                ),
              )
              .limit(1);
            if (!parent) {
              throw new RepositoryConflictError(
                "INVALID_DATASET_PARENT",
                "Parent version must belong to the same dataset",
              );
            }
          }

          const [duplicate] = await tx
            .select({ version: datasetVersions.version })
            .from(datasetVersions)
            .where(
              and(
                eq(datasetVersions.datasetId, datasetId),
                eq(datasetVersions.contentHash, contentHash),
              ),
            )
            .limit(1);
          if (duplicate) {
            throw new RepositoryConflictError(
              "DATASET_VERSION_CONTENT_EXISTS",
              `Identical dataset content already exists as version ${duplicate.version}`,
            );
          }

          const [created] = await tx
            .insert(datasetVersions)
            .values({
              datasetId,
              version,
              status: "draft",
              source,
              contentHash,
              caseCount: cases.length,
              generationProvenance: provenance,
              parentVersionId,
              changeSummary: normalizeChangeSummary(input.changeSummary),
              createdBy: normalizeActor(input.createdBy),
            })
            .returning();
          if (!created) throw new Error("PostgreSQL did not return the created dataset version");

          await tx.insert(evaluationCases).values(
            cases.map((evaluationCase) => ({
              datasetVersionId: created.id,
              ...evaluationCase,
            })),
          );
          return created;
        });
      } catch (error) {
        if (
          error instanceof EntityNotFoundError ||
          error instanceof RepositoryConflictError ||
          error instanceof VersionContentError
        ) {
          throw error;
        }
        mapUniqueViolation(
          error,
          "DATASET_VERSION_CONFLICT",
          "Dataset version number, content, or case key already exists",
        );
      }
    },

    async listVersions(datasetId) {
      return db
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.datasetId, datasetId))
        .orderBy(desc(datasetVersions.version));
    },

    async getVersionById(id) {
      const [version] = await db
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.id, id))
        .limit(1);
      return version ?? null;
    },

    async listCases(versionId) {
      return db
        .select()
        .from(evaluationCases)
        .where(eq(evaluationCases.datasetVersionId, versionId))
        .orderBy(asc(evaluationCases.sortOrder), asc(evaluationCases.id));
    },

    async publishVersion(id) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${datasetVersions.id} from ${datasetVersions} where ${datasetVersions.id} = ${id} for update`,
        );
        const [existing] = await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.id, id))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("DatasetVersion", id);
        if (existing.status === "published") return existing;
        if (existing.status !== "draft") {
          throw new InvalidVersionStateError(
            existing.status,
            `Cannot publish a dataset version in ${existing.status} state`,
          );
        }
        if (existing.caseCount < 1) {
          throw new RepositoryConflictError(
            "DATASET_VERSION_EMPTY",
            "A dataset version must contain at least one case before publishing",
          );
        }

        const [published] = await tx
          .update(datasetVersions)
          .set({ status: "published", publishedAt: new Date() })
          .where(eq(datasetVersions.id, id))
          .returning();
        if (!published) throw new EntityNotFoundError("DatasetVersion", id);
        return published;
      });
    },
  };
}

export function normalizeEvaluationCases(
  input: readonly EvaluationCaseInput[],
): NormalizedEvaluationCase[] {
  if (!isRuntimeArray(input) || input.length < 1 || input.length > 5_000) {
    throw new VersionContentError("A dataset version must contain 1-5000 cases");
  }
  const keys = new Set<string>();
  return input.map((item, index) => {
    const caseKey = normalizeCaseKey(item.caseKey, index);
    if (keys.has(caseKey)) throw new VersionContentError(`Duplicate evaluation case key: ${caseKey}`);
    keys.add(caseKey);
    const name = normalizeCaseName(item.name, index);
    const metadata = normalizeMetadata(item.metadata, index);
    assertJsonSize(item.input, `cases[${index}].input`, 1_000_000);
    assertJsonSize(item.expectedOutput ?? null, `cases[${index}].expectedOutput`, 1_000_000);
    const normalized = {
      caseKey,
      name,
      input: item.input,
      expectedOutput: item.expectedOutput ?? null,
      metadata,
      sortOrder: index,
    };
    return {
      ...normalized,
      contentHash: hashVersionContent({ format: "evaluation-case/v1", ...normalized }),
    };
  });
}

export function hashDatasetCases(cases: readonly NormalizedEvaluationCase[]): string {
  return hashVersionContent({
    format: "evaluation-dataset/v1",
    cases: cases.map((evaluationCase) => ({
      caseKey: evaluationCase.caseKey,
      name: evaluationCase.name,
      input: evaluationCase.input,
      expectedOutput: evaluationCase.expectedOutput,
      metadata: evaluationCase.metadata,
      sortOrder: evaluationCase.sortOrder,
    })),
  });
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function normalizeDatasetSource(value: DatasetSource | undefined): DatasetSource {
  const source = value ?? "manual";
  if (!datasetSources.has(source)) throw new VersionContentError("Unsupported dataset source");
  return source;
}

function normalizeCaseKey(value: string, index: number): string {
  if (typeof value !== "string") {
    throw new VersionContentError(`cases[${index}].caseKey is required`);
  }
  const normalized = value.trim();
  if (!caseKeyPattern.test(normalized)) {
    throw new VersionContentError(
      `cases[${index}].caseKey must be 1-120 letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return normalized;
}

function normalizeCaseName(value: string | null | undefined, index: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > 240) {
    throw new VersionContentError(`cases[${index}].name must be at most 240 characters`);
  }
  return normalized === "" ? null : normalized;
}

function normalizeProvenance(value: JsonValue | null | undefined): JsonValue | null {
  if (value === undefined || value === null) return null;
  assertJsonSize(value, "generationProvenance", 100_000);
  return value;
}

function normalizeMetadata(
  value: Record<string, JsonValue> | undefined,
  index: number,
): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VersionContentError(`cases[${index}].metadata must be an object`);
  }
  if (Object.keys(value).length > 100) {
    throw new VersionContentError(`cases[${index}].metadata may contain at most 100 fields`);
  }
  assertJsonSize(value, `cases[${index}].metadata`, 100_000);
  return value;
}

function assertJsonSize(value: unknown, label: string, maximum: number): void {
  const serialized = stableStringify(value);
  if (serialized.length > maximum) {
    throw new VersionContentError(`${label} must be at most ${maximum} serialized characters`);
  }
}

function normalizeActor(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 255) throw new TypeError("createdBy must be at most 255 characters");
  return normalized;
}
