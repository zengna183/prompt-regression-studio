import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { RepositoryDatabase } from "../client.js";
import { EntityNotFoundError, RepositoryConflictError } from "../errors.js";
import { decryptModelApiKey, encryptModelApiKey } from "../model-credentials.js";
import { auditEvents, modelConnections, projects, type ModelConnection } from "../schema.js";

export interface ModelConnectionMetadata {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  allowedModels: string[];
  supportsSeed: boolean;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedModelConnection extends ModelConnectionMetadata {
  apiKey: string;
}

export interface ModelConnectionRepository {
  list(projectId: string): Promise<ModelConnectionMetadata[]>;
  create(input: {
    projectId: string;
    name: string;
    baseUrl: string;
    allowedModels: string[];
    apiKey: string;
    supportsSeed: boolean;
  }): Promise<ModelConnectionMetadata>;
  get(projectId: string, id: string): Promise<ModelConnectionMetadata | null>;
  resolve(projectId: string, id: string): Promise<ResolvedModelConnection | null>;
  rotate(projectId: string, id: string, apiKey: string): Promise<ModelConnectionMetadata>;
  disable(projectId: string, id: string): Promise<ModelConnectionMetadata>;
}

function metadata(row: ModelConnection): ModelConnectionMetadata {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    baseUrl: row.baseUrl,
    allowedModels: row.allowedModels,
    supportsSeed: row.supportsSeed,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createModelConnectionRepository(
  db: RepositoryDatabase,
  key: Buffer,
): ModelConnectionRepository {
  if (key.length !== 32) throw new TypeError("Model encryption key must be 32 bytes");
  return {
    async list(projectId) {
      const rows = await db
        .select()
        .from(modelConnections)
        .where(eq(modelConnections.projectId, projectId))
        .orderBy(asc(modelConnections.createdAt), asc(modelConnections.id));
      return rows.map(metadata);
    },
    async create(input) {
      const name = input.name.trim();
      if (!name || name.length > 120)
        throw new TypeError("Connection name must be 1-120 characters");
      if (
        !Array.isArray(input.allowedModels) ||
        input.allowedModels.length < 1 ||
        input.allowedModels.length > 50 ||
        input.allowedModels.some(
          (model) =>
            typeof model !== "string" ||
            !model ||
            model.length > 240 ||
            [...model].some(
              (character) =>
                character.trim() === "" ||
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127,
            ),
        ) ||
        new Set(input.allowedModels).size !== input.allowedModels.length
      ) {
        throw new TypeError("The connection must allow 1-50 distinct valid model identifiers");
      }
      return db.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), isNull(projects.archivedAt)))
          .limit(1);
        if (!project) throw new EntityNotFoundError("Project", input.projectId);
        const id = randomUUID();
        const [row] = await tx
          .insert(modelConnections)
          .values({
            id,
            projectId: input.projectId,
            name,
            baseUrl: input.baseUrl,
            allowedModels: input.allowedModels,
            apiKeyCiphertext: encryptModelApiKey(input.apiKey, key, input.projectId, id),
            supportsSeed: input.supportsSeed,
          })
          .onConflictDoNothing({ target: [modelConnections.projectId, modelConnections.name] })
          .returning();
        if (!row)
          throw new RepositoryConflictError(
            "MODEL_CONNECTION_NAME_EXISTS",
            "A model connection with this name already exists in this project.",
          );
        await tx.insert(auditEvents).values({
          projectId: input.projectId,
          actorType: "service",
          action: "model_connection.created",
          entityType: "model_connection",
          entityId: id,
        });
        return metadata(row);
      });
    },
    async get(projectId, id) {
      const [row] = await db
        .select()
        .from(modelConnections)
        .where(and(eq(modelConnections.projectId, projectId), eq(modelConnections.id, id)))
        .limit(1);
      return row ? metadata(row) : null;
    },
    async resolve(projectId, id) {
      const [row] = await db
        .select()
        .from(modelConnections)
        .where(and(eq(modelConnections.projectId, projectId), eq(modelConnections.id, id)))
        .limit(1);
      if (!row || row.disabledAt) return null;
      return {
        ...metadata(row),
        apiKey: decryptModelApiKey(row.apiKeyCiphertext, key, projectId, id),
      };
    },
    async rotate(projectId, id, apiKey) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(modelConnections)
          .set({
            apiKeyCiphertext: encryptModelApiKey(apiKey, key, projectId, id),
            updatedAt: new Date(),
          })
          .where(and(eq(modelConnections.projectId, projectId), eq(modelConnections.id, id)))
          .returning();
        if (!row) throw new EntityNotFoundError("ModelConnection", id);
        await tx.insert(auditEvents).values({
          projectId,
          actorType: "service",
          action: "model_connection.key_rotated",
          entityType: "model_connection",
          entityId: id,
        });
        return metadata(row);
      });
    },
    async disable(projectId, id) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(modelConnections)
          .set({ disabledAt: new Date(), updatedAt: new Date() })
          .where(and(eq(modelConnections.projectId, projectId), eq(modelConnections.id, id)))
          .returning();
        if (!row) throw new EntityNotFoundError("ModelConnection", id);
        await tx.insert(auditEvents).values({
          projectId,
          actorType: "service",
          action: "model_connection.disabled",
          entityType: "model_connection",
          entityId: id,
        });
        return metadata(row);
      });
    },
  };
}
