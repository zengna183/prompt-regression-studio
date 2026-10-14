import type { DatasetRepository, ModelConnectionRepository } from "@ai-chat-eval/db";
import { OpenAICompatibleClient, ProviderError } from "@prompt-regression/model-provider";

import { createDatasetCaseGenerator, type DatasetCaseGenerator } from "./dataset-generation.js";
import { ApiError } from "./errors.js";

export function createManagedDatasetCaseGenerator(options: {
  datasets: Pick<DatasetRepository, "getById">;
  connections?: Pick<ModelConnectionRepository, "resolve">;
  legacy?: DatasetCaseGenerator;
  production: boolean;
  allowedHosts: readonly string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): DatasetCaseGenerator {
  let active = 0;
  return {
    async generate(input, datasetId) {
      if (active >= 2)
        throw new ApiError(429, "DATASET_GENERATION_BUSY", "AI 生成任务繁忙，请稍后重试。");
      active++;
      try {
        if (!input.modelConnectionId) {
          if (input.model || !options.legacy) {
            throw new ApiError(
              422,
              "MODEL_CONNECTION_REQUIRED",
              "Select a model connection and model for AI dataset generation.",
            );
          }
          return await options.legacy.generate(input, datasetId);
        }
        if (!datasetId || !input.model || !options.connections) {
          throw new ApiError(
            422,
            "MODEL_CONNECTION_REQUIRED",
            "Select a valid model connection and model.",
          );
        }
        const dataset = await options.datasets.getById(datasetId);
        if (!dataset || dataset.archivedAt)
          throw new ApiError(404, "NOT_FOUND", "Active dataset not found.");
        const connection = await options.connections.resolve(
          dataset.projectId,
          input.modelConnectionId,
        );
        if (!connection || !connection.allowedModels.includes(input.model)) {
          throw new ApiError(
            409,
            "MODEL_CONNECTION_UNAVAILABLE",
            "The selected model connection is unavailable or does not allow this model.",
          );
        }
        let model: OpenAICompatibleClient;
        try {
          model = new OpenAICompatibleClient({
            baseUrl: connection.baseUrl,
            apiKey: connection.apiKey,
            production: options.production,
            allowPrivateNetwork: !options.production,
            ...(options.production ? { allowedHosts: options.allowedHosts } : {}),
            timeoutMs: options.timeoutMs,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
        } catch (error) {
          if (error instanceof ProviderError) throw new ApiError(422, error.code, error.message);
          throw error;
        }
        return await createDatasetCaseGenerator(model, input.model).generate(input);
      } finally {
        active--;
      }
    },
  };
}
