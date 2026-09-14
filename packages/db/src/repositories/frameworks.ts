import { and, asc, desc, eq, max, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  EntityNotFoundError,
  InvalidVersionStateError,
  RepositoryConflictError,
} from "../errors.js";
import {
  evaluationFrameworks,
  evaluationFrameworkVersions,
  type EvaluationFramework,
  type EvaluationFrameworkVersion,
  type FrameworkDefinition,
} from "../schema.js";
import {
  assertCanArchive,
  hashFrameworkDefinition,
  nextVersionNumber,
  normalizeFrameworkDefinition,
  VersionContentError,
} from "../versioning.js";
import {
  mapUniqueViolation,
  normalizeChangeSummary,
  normalizeDescription,
  normalizeKey,
  normalizeName,
} from "./common.js";

export interface CreateFrameworkInput {
  readonly projectId: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface UpdateFrameworkInput {
  readonly name?: string;
  readonly description?: string | null;
}

export interface CreateFrameworkVersionInput {
  readonly definition: FrameworkDefinition;
  /** Undefined links to the latest version; null explicitly creates a new root. */
  readonly parentVersionId?: string | null;
  readonly changeSummary?: string | null;
  readonly createdBy?: string | null;
}

export interface FrameworkRepository {
  create(input: CreateFrameworkInput): Promise<EvaluationFramework>;
  getById(id: string): Promise<EvaluationFramework | null>;
  getByKey(projectId: string, key: string): Promise<EvaluationFramework | null>;
  listByProject(projectId: string): Promise<EvaluationFramework[]>;
  update(id: string, input: UpdateFrameworkInput): Promise<EvaluationFramework>;
  createVersion(
    frameworkId: string,
    input: CreateFrameworkVersionInput,
  ): Promise<EvaluationFrameworkVersion>;
  getVersionById(id: string): Promise<EvaluationFrameworkVersion | null>;
  listVersions(frameworkId: string): Promise<EvaluationFrameworkVersion[]>;
  publishVersion(id: string): Promise<EvaluationFrameworkVersion>;
  archiveVersion(id: string): Promise<EvaluationFrameworkVersion>;
}

function normalizeActorId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 255) throw new TypeError("createdBy must be at most 255 characters");
  return normalized;
}

export function createFrameworkRepository(db: Database): FrameworkRepository {
  return {
    async create(input) {
      try {
        const [created] = await db
          .insert(evaluationFrameworks)
          .values({
            projectId: input.projectId,
            key: normalizeKey(input.key, "framework key"),
            name: normalizeName(input.name, "framework name"),
            description: normalizeDescription(input.description),
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the created evaluation framework");
        return created;
      } catch (error) {
        mapUniqueViolation(
          error,
          "FRAMEWORK_KEY_EXISTS",
          `Framework key already exists in this project: ${input.key}`,
        );
      }
    },

    async getById(id) {
      const [framework] = await db
        .select()
        .from(evaluationFrameworks)
        .where(eq(evaluationFrameworks.id, id))
        .limit(1);
      return framework ?? null;
    },

    async getByKey(projectId, key) {
      const [framework] = await db
        .select()
        .from(evaluationFrameworks)
        .where(
          and(
            eq(evaluationFrameworks.projectId, projectId),
            eq(evaluationFrameworks.key, normalizeKey(key, "framework key")),
          ),
        )
        .limit(1);
      return framework ?? null;
    },

    async listByProject(projectId) {
      return db
        .select()
        .from(evaluationFrameworks)
        .where(eq(evaluationFrameworks.projectId, projectId))
        .orderBy(asc(evaluationFrameworks.createdAt), asc(evaluationFrameworks.id));
    },

    async update(id, input) {
      const values: { name?: string; description?: string | null; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) values.name = normalizeName(input.name, "framework name");
      if (input.description !== undefined)
        values.description = normalizeDescription(input.description);

      const [updated] = await db
        .update(evaluationFrameworks)
        .set(values)
        .where(eq(evaluationFrameworks.id, id))
        .returning();
      if (!updated) throw new EntityNotFoundError("EvaluationFramework", id);
      return updated;
    },

    async createVersion(frameworkId, input) {
      const definition = normalizeFrameworkDefinition(input.definition);
      const contentHash = hashFrameworkDefinition(definition);

      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`select ${evaluationFrameworks.id} from ${evaluationFrameworks} where ${evaluationFrameworks.id} = ${frameworkId} for update`,
          );
          const [framework] = await tx
            .select()
            .from(evaluationFrameworks)
            .where(eq(evaluationFrameworks.id, frameworkId))
            .limit(1);
          if (!framework) throw new EntityNotFoundError("EvaluationFramework", frameworkId);
          if (framework.archivedAt) {
            throw new RepositoryConflictError(
              "FRAMEWORK_ARCHIVED",
              "Cannot create a version for an archived evaluation framework",
            );
          }

          const [latest] = await tx
            .select({
              id: evaluationFrameworkVersions.id,
              version: evaluationFrameworkVersions.version,
            })
            .from(evaluationFrameworkVersions)
            .where(eq(evaluationFrameworkVersions.frameworkId, frameworkId))
            .orderBy(desc(evaluationFrameworkVersions.version))
            .limit(1);
          const [aggregate] = await tx
            .select({ maximum: max(evaluationFrameworkVersions.version) })
            .from(evaluationFrameworkVersions)
            .where(eq(evaluationFrameworkVersions.frameworkId, frameworkId));
          const version = nextVersionNumber(
            aggregate?.maximum === null || aggregate?.maximum === undefined
              ? null
              : Number(aggregate.maximum),
          );

          const parentVersionId =
            input.parentVersionId === undefined ? (latest?.id ?? null) : input.parentVersionId;
          if (parentVersionId !== null) {
            const [parent] = await tx
              .select({ id: evaluationFrameworkVersions.id })
              .from(evaluationFrameworkVersions)
              .where(
                and(
                  eq(evaluationFrameworkVersions.id, parentVersionId),
                  eq(evaluationFrameworkVersions.frameworkId, frameworkId),
                ),
              )
              .limit(1);
            if (!parent) {
              throw new RepositoryConflictError(
                "INVALID_FRAMEWORK_PARENT",
                "Parent version must belong to the same evaluation framework",
              );
            }
          }

          const [duplicate] = await tx
            .select({
              id: evaluationFrameworkVersions.id,
              version: evaluationFrameworkVersions.version,
            })
            .from(evaluationFrameworkVersions)
            .where(
              and(
                eq(evaluationFrameworkVersions.frameworkId, frameworkId),
                eq(evaluationFrameworkVersions.contentHash, contentHash),
              ),
            )
            .limit(1);
          if (duplicate) {
            throw new RepositoryConflictError(
              "FRAMEWORK_VERSION_CONTENT_EXISTS",
              `Identical framework content already exists as version ${duplicate.version}`,
            );
          }

          const [created] = await tx
            .insert(evaluationFrameworkVersions)
            .values({
              frameworkId,
              version,
              status: "draft",
              definition,
              contentHash,
              parentVersionId,
              changeSummary: normalizeChangeSummary(input.changeSummary),
              createdBy: normalizeActorId(input.createdBy),
            })
            .returning();
          if (!created) throw new Error("PostgreSQL did not return the created framework version");
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
          "FRAMEWORK_VERSION_CONFLICT",
          "Framework version number or content already exists",
        );
      }
    },

    async getVersionById(id) {
      const [version] = await db
        .select()
        .from(evaluationFrameworkVersions)
        .where(eq(evaluationFrameworkVersions.id, id))
        .limit(1);
      return version ?? null;
    },

    async listVersions(frameworkId) {
      return db
        .select()
        .from(evaluationFrameworkVersions)
        .where(eq(evaluationFrameworkVersions.frameworkId, frameworkId))
        .orderBy(desc(evaluationFrameworkVersions.version));
    },

    async publishVersion(id) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${evaluationFrameworkVersions.id} from ${evaluationFrameworkVersions} where ${evaluationFrameworkVersions.id} = ${id} for update`,
        );
        const [existing] = await tx
          .select()
          .from(evaluationFrameworkVersions)
          .where(eq(evaluationFrameworkVersions.id, id))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("EvaluationFrameworkVersion", id);
        if (existing.status === "published") return existing;
        if (existing.status !== "draft") {
          throw new InvalidVersionStateError(
            existing.status,
            `Cannot publish a framework version in ${existing.status} state`,
          );
        }

        const [published] = await tx
          .update(evaluationFrameworkVersions)
          .set({ status: "published", publishedAt: new Date() })
          .where(eq(evaluationFrameworkVersions.id, id))
          .returning();
        if (!published) throw new EntityNotFoundError("EvaluationFrameworkVersion", id);
        return published;
      });
    },

    async archiveVersion(id) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${evaluationFrameworkVersions.id} from ${evaluationFrameworkVersions} where ${evaluationFrameworkVersions.id} = ${id} for update`,
        );
        const [existing] = await tx
          .select()
          .from(evaluationFrameworkVersions)
          .where(eq(evaluationFrameworkVersions.id, id))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("EvaluationFrameworkVersion", id);
        try {
          assertCanArchive(existing.status);
        } catch (error) {
          if (error instanceof VersionContentError) {
            throw new InvalidVersionStateError(existing.status, error.message);
          }
          throw error;
        }

        const [archived] = await tx
          .update(evaluationFrameworkVersions)
          .set({ status: "archived", archivedAt: new Date() })
          .where(eq(evaluationFrameworkVersions.id, id))
          .returning();
        if (!archived) throw new EntityNotFoundError("EvaluationFrameworkVersion", id);
        return archived;
      });
    },
  };
}
