import { and, asc, desc, eq, max, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  EntityNotFoundError,
  InvalidVersionStateError,
  RepositoryConflictError,
} from "../errors.js";
import {
  prompts,
  promptVersions,
  type Prompt,
  type PromptBlock,
  type PromptVersion,
} from "../schema.js";
import {
  assertCanArchive,
  compilePrompt,
  hashPromptBlocks,
  nextVersionNumber,
  normalizePromptBlocks,
  VersionContentError,
} from "../versioning.js";
import {
  mapUniqueViolation,
  normalizeChangeSummary,
  normalizeDescription,
  normalizeKey,
  normalizeName,
} from "./common.js";

export interface CreatePromptInput {
  readonly projectId: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface UpdatePromptInput {
  readonly name?: string;
  readonly description?: string | null;
}

export interface CreatePromptVersionInput {
  readonly blocks: readonly PromptBlock[];
  /** Undefined links to the latest version; null explicitly creates a new root. */
  readonly parentVersionId?: string | null;
  readonly changeSummary?: string | null;
  readonly createdBy?: string | null;
}

export interface PromptRepository {
  create(input: CreatePromptInput): Promise<Prompt>;
  getById(id: string): Promise<Prompt | null>;
  getByKey(projectId: string, key: string): Promise<Prompt | null>;
  listByProject(projectId: string): Promise<Prompt[]>;
  update(id: string, input: UpdatePromptInput): Promise<Prompt>;
  createVersion(promptId: string, input: CreatePromptVersionInput): Promise<PromptVersion>;
  getVersionById(id: string): Promise<PromptVersion | null>;
  listVersions(promptId: string): Promise<PromptVersion[]>;
  publishVersion(id: string): Promise<PromptVersion>;
  archiveVersion(id: string): Promise<PromptVersion>;
}

function normalizeActorId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 255) throw new TypeError("createdBy must be at most 255 characters");
  return normalized;
}

export function createPromptRepository(db: Database): PromptRepository {
  return {
    async create(input) {
      try {
        const [created] = await db
          .insert(prompts)
          .values({
            projectId: input.projectId,
            key: normalizeKey(input.key, "prompt key"),
            name: normalizeName(input.name, "prompt name"),
            description: normalizeDescription(input.description),
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the created Prompt");
        return created;
      } catch (error) {
        mapUniqueViolation(
          error,
          "PROMPT_KEY_EXISTS",
          `Prompt key already exists in this project: ${input.key}`,
        );
      }
    },

    async getById(id) {
      const [prompt] = await db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
      return prompt ?? null;
    },

    async getByKey(projectId, key) {
      const [prompt] = await db
        .select()
        .from(prompts)
        .where(
          and(eq(prompts.projectId, projectId), eq(prompts.key, normalizeKey(key, "prompt key"))),
        )
        .limit(1);
      return prompt ?? null;
    },

    async listByProject(projectId) {
      return db
        .select()
        .from(prompts)
        .where(eq(prompts.projectId, projectId))
        .orderBy(asc(prompts.createdAt), asc(prompts.id));
    },

    async update(id, input) {
      const values: { name?: string; description?: string | null; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) values.name = normalizeName(input.name, "prompt name");
      if (input.description !== undefined)
        values.description = normalizeDescription(input.description);

      const [updated] = await db.update(prompts).set(values).where(eq(prompts.id, id)).returning();
      if (!updated) throw new EntityNotFoundError("Prompt", id);
      return updated;
    },

    async createVersion(promptId, input) {
      const normalizedBlocks = normalizePromptBlocks(input.blocks);
      const compiled = compilePrompt(normalizedBlocks);
      const contentHash = hashPromptBlocks(normalizedBlocks);

      try {
        return await db.transaction(async (tx) => {
          // Serializes version-number allocation per Prompt without locking unrelated Prompts.
          await tx.execute(
            sql`select ${prompts.id} from ${prompts} where ${prompts.id} = ${promptId} for update`,
          );
          const [prompt] = await tx.select().from(prompts).where(eq(prompts.id, promptId)).limit(1);
          if (!prompt) throw new EntityNotFoundError("Prompt", promptId);
          if (prompt.archivedAt) {
            throw new RepositoryConflictError(
              "PROMPT_ARCHIVED",
              "Cannot create a version for an archived Prompt",
            );
          }

          const [latest] = await tx
            .select({ id: promptVersions.id, version: promptVersions.version })
            .from(promptVersions)
            .where(eq(promptVersions.promptId, promptId))
            .orderBy(desc(promptVersions.version))
            .limit(1);
          const [aggregate] = await tx
            .select({ maximum: max(promptVersions.version) })
            .from(promptVersions)
            .where(eq(promptVersions.promptId, promptId));
          const version = nextVersionNumber(
            aggregate?.maximum === null || aggregate?.maximum === undefined
              ? null
              : Number(aggregate.maximum),
          );

          const parentVersionId =
            input.parentVersionId === undefined ? (latest?.id ?? null) : input.parentVersionId;
          if (parentVersionId !== null) {
            const [parent] = await tx
              .select({ id: promptVersions.id })
              .from(promptVersions)
              .where(
                and(eq(promptVersions.id, parentVersionId), eq(promptVersions.promptId, promptId)),
              )
              .limit(1);
            if (!parent) {
              throw new RepositoryConflictError(
                "INVALID_PROMPT_PARENT",
                "Parent version must belong to the same Prompt",
              );
            }
          }

          const [duplicate] = await tx
            .select({ id: promptVersions.id, version: promptVersions.version })
            .from(promptVersions)
            .where(
              and(
                eq(promptVersions.promptId, promptId),
                eq(promptVersions.contentHash, contentHash),
              ),
            )
            .limit(1);
          if (duplicate) {
            throw new RepositoryConflictError(
              "PROMPT_VERSION_CONTENT_EXISTS",
              `Identical Prompt content already exists as version ${duplicate.version}`,
            );
          }

          const [created] = await tx
            .insert(promptVersions)
            .values({
              promptId,
              version,
              status: "draft",
              blocks: normalizedBlocks,
              compiledContent: compiled.content,
              sourceMap: compiled.sourceMap,
              contentHash,
              parentVersionId,
              changeSummary: normalizeChangeSummary(input.changeSummary),
              createdBy: normalizeActorId(input.createdBy),
            })
            .returning();
          if (!created) throw new Error("PostgreSQL did not return the created Prompt version");
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
          "PROMPT_VERSION_CONFLICT",
          "Prompt version number or content already exists",
        );
      }
    },

    async getVersionById(id) {
      const [version] = await db
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.id, id))
        .limit(1);
      return version ?? null;
    },

    async listVersions(promptId) {
      return db
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.promptId, promptId))
        .orderBy(desc(promptVersions.version));
    },

    async publishVersion(id) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${promptVersions.id} from ${promptVersions} where ${promptVersions.id} = ${id} for update`,
        );
        const [existing] = await tx
          .select()
          .from(promptVersions)
          .where(eq(promptVersions.id, id))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("PromptVersion", id);
        if (existing.status === "published") return existing;
        if (existing.status !== "draft") {
          throw new InvalidVersionStateError(
            existing.status,
            `Cannot publish a Prompt version in ${existing.status} state`,
          );
        }

        const [published] = await tx
          .update(promptVersions)
          .set({ status: "published", publishedAt: new Date() })
          .where(eq(promptVersions.id, id))
          .returning();
        if (!published) throw new EntityNotFoundError("PromptVersion", id);
        return published;
      });
    },

    async archiveVersion(id) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${promptVersions.id} from ${promptVersions} where ${promptVersions.id} = ${id} for update`,
        );
        const [existing] = await tx
          .select()
          .from(promptVersions)
          .where(eq(promptVersions.id, id))
          .limit(1);
        if (!existing) throw new EntityNotFoundError("PromptVersion", id);
        try {
          assertCanArchive(existing.status);
        } catch (error) {
          if (error instanceof VersionContentError) {
            throw new InvalidVersionStateError(existing.status, error.message);
          }
          throw error;
        }

        const [archived] = await tx
          .update(promptVersions)
          .set({ status: "archived", archivedAt: new Date() })
          .where(eq(promptVersions.id, id))
          .returning();
        if (!archived) throw new EntityNotFoundError("PromptVersion", id);
        return archived;
      });
    },
  };
}
