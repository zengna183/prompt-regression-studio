import { asc, eq, isNull } from "drizzle-orm";

import type { Database } from "../client.js";
import { EntityNotFoundError } from "../errors.js";
import { projects, type Project } from "../schema.js";
import { mapUniqueViolation, normalizeDescription, normalizeKey, normalizeName } from "./common.js";

export interface CreateProjectInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
}

export interface ListProjectsOptions {
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  getById(id: string): Promise<Project | null>;
  getBySlug(slug: string): Promise<Project | null>;
  list(options?: ListProjectsOptions): Promise<Project[]>;
  update(id: string, input: UpdateProjectInput): Promise<Project>;
  archive(id: string): Promise<Project>;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new TypeError("limit must be an integer from 1 to 200");
  }
  return value;
}

function pageOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError("offset must be a non-negative integer");
  return value;
}

export function createProjectRepository(db: Database): ProjectRepository {
  return {
    async create(input) {
      try {
        const [created] = await db
          .insert(projects)
          .values({
            slug: normalizeKey(input.slug, "project slug"),
            name: normalizeName(input.name, "project name"),
            description: normalizeDescription(input.description),
          })
          .returning();
        if (!created) throw new Error("PostgreSQL did not return the created project");
        return created;
      } catch (error) {
        mapUniqueViolation(
          error,
          "PROJECT_SLUG_EXISTS",
          `Project slug already exists: ${input.slug}`,
        );
      }
    },

    async getById(id) {
      const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return project ?? null;
    },

    async getBySlug(slug) {
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.slug, normalizeKey(slug, "project slug")))
        .limit(1);
      return project ?? null;
    },

    async list(options = {}) {
      const limit = pageLimit(options.limit);
      const offset = pageOffset(options.offset);
      if (options.includeArchived) {
        return db
          .select()
          .from(projects)
          .orderBy(asc(projects.createdAt), asc(projects.id))
          .limit(limit)
          .offset(offset);
      }
      return db
        .select()
        .from(projects)
        .where(isNull(projects.archivedAt))
        .orderBy(asc(projects.createdAt), asc(projects.id))
        .limit(limit)
        .offset(offset);
    },

    async update(id, input) {
      const values: { name?: string; description?: string | null; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) values.name = normalizeName(input.name, "project name");
      if (input.description !== undefined)
        values.description = normalizeDescription(input.description);

      const [updated] = await db
        .update(projects)
        .set(values)
        .where(eq(projects.id, id))
        .returning();
      if (!updated) throw new EntityNotFoundError("Project", id);
      return updated;
    },

    async archive(id) {
      const now = new Date();
      const [archived] = await db
        .update(projects)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(projects.id, id))
        .returning();
      if (!archived) throw new EntityNotFoundError("Project", id);
      return archived;
    },
  };
}
