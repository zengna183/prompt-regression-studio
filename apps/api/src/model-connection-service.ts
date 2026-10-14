import {
  createModelConnectionRepository,
  EntityNotFoundError,
  RepositoryConflictError,
  type Database,
  type ModelConnectionMetadata,
} from "@ai-chat-eval/db";
import { OpenAICompatibleClient, ProviderError } from "@prompt-regression/model-provider";

import { ApiError } from "./errors.js";

export interface ModelConnectionInput {
  name: string;
  baseUrl: string;
  allowedModels: string[];
  apiKey: string;
  supportsSeed: boolean;
}

export interface ModelConnectionService {
  list(projectId: string): Promise<ModelConnectionMetadata[]>;
  create(projectId: string, input: ModelConnectionInput): Promise<ModelConnectionMetadata>;
  rotate(projectId: string, id: string, apiKey: string): Promise<ModelConnectionMetadata>;
  disable(projectId: string, id: string): Promise<ModelConnectionMetadata>;
  test(projectId: string, id: string): Promise<{ reachable: boolean; code: string }>;
}

export function createModelConnectionService(
  db: Database,
  key: Buffer,
  options: {
    production: boolean;
    allowedHosts: readonly string[];
    timeoutMs: number;
  },
): ModelConnectionService {
  const repository = createModelConnectionRepository(db, key);
  function validateEndpoint(baseUrl: string, apiKey: string): OpenAICompatibleClient {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new ApiError(422, "INVALID_MODEL_CONNECTION", "The model provider URL is invalid.");
    }
    if (url.search || url.hash) {
      throw new ApiError(
        422,
        "INVALID_MODEL_CONNECTION",
        "Put credentials in the API key field; provider URLs must not contain query parameters or fragments.",
      );
    }
    try {
      return new OpenAICompatibleClient({
        baseUrl,
        apiKey,
        production: options.production,
        allowPrivateNetwork: !options.production,
        ...(options.production ? { allowedHosts: options.allowedHosts } : {}),
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ApiError(422, "INVALID_MODEL_CONNECTION", error.message);
      }
      throw error;
    }
  }

  return {
    list: (projectId) => repository.list(projectId),
    async create(projectId, input) {
      validateEndpoint(input.baseUrl, input.apiKey);
      if (new Set(input.allowedModels).size !== input.allowedModels.length) {
        throw new ApiError(422, "INVALID_MODEL_CONNECTION", "Model identifiers must be unique.");
      }
      try {
        return await repository.create({ projectId, ...input });
      } catch (error) {
        if (error instanceof EntityNotFoundError)
          throw new ApiError(404, "NOT_FOUND", error.message);
        if (error instanceof RepositoryConflictError)
          throw new ApiError(409, error.code, error.message);
        if (error instanceof TypeError)
          throw new ApiError(422, "INVALID_MODEL_CONNECTION", error.message);
        throw error;
      }
    },
    async rotate(projectId, id, apiKey) {
      const existing = await repository.get(projectId, id);
      if (!existing) throw new ApiError(404, "NOT_FOUND", "Model connection not found.");
      validateEndpoint(existing.baseUrl, apiKey);
      try {
        return await repository.rotate(projectId, id, apiKey);
      } catch (error) {
        if (error instanceof EntityNotFoundError)
          throw new ApiError(404, "NOT_FOUND", "Model connection not found.");
        throw error;
      }
    },
    async disable(projectId, id) {
      try {
        return await repository.disable(projectId, id);
      } catch (error) {
        if (error instanceof EntityNotFoundError)
          throw new ApiError(404, "NOT_FOUND", "Model connection not found.");
        throw error;
      }
    },
    async test(projectId, id) {
      const connection = await repository.resolve(projectId, id);
      if (!connection) throw new ApiError(404, "NOT_FOUND", "Active model connection not found.");
      const model = connection.allowedModels[0];
      if (!model)
        throw new ApiError(422, "INVALID_MODEL_CONNECTION", "This connection has no model.");
      const client = validateEndpoint(connection.baseUrl, connection.apiKey);
      try {
        await client.complete({
          model,
          messages: [{ role: "user", content: "Reply OK." }],
          maxTokens: 8,
        });
        return { reachable: true, code: "OK" };
      } catch (error) {
        if (error instanceof ProviderError) return { reachable: false, code: error.code };
        throw error;
      }
    },
  };
}
