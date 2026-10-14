import type { Dataset, ResolvedModelConnection } from "@ai-chat-eval/db";
import { describe, expect, it, vi } from "vitest";

import { createManagedDatasetCaseGenerator } from "./managed-dataset-generation.js";

const input = {
  brief: "测试客服回答是否准确并包含必要信息",
  count: 1,
  modelConnectionId: "connection-1",
  model: "case-model",
};
const dataset = { id: "dataset-1", projectId: "project-1", archivedAt: null } as Dataset;
const connection: ResolvedModelConnection = {
  id: "connection-1",
  projectId: "project-1",
  name: "Test",
  baseUrl: "https://models.example.com",
  allowedModels: ["case-model"],
  apiKey: "secret-model-key",
  supportsSeed: true,
  disabledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const output = () =>
  new Response(
    JSON.stringify({
      model: "case-model",
      choices: [
        {
          message: {
            content: JSON.stringify({
              cases: [
                {
                  name: "Refund",
                  input: "Can I get a refund?",
                  expectedOutput: "Check the refund policy.",
                },
              ],
            }),
          },
        },
      ],
    }),
  );

describe("managed dataset generation", () => {
  it("resolves the credential under the dataset project and persists only provenance", async () => {
    const resolve = vi.fn(() => Promise.resolve(connection));
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(output()));
    const generator = createManagedDatasetCaseGenerator({
      datasets: { getById: vi.fn(() => Promise.resolve(dataset)) },
      connections: { resolve },
      production: true,
      allowedHosts: ["models.example.com"],
      timeoutMs: 1_000,
      fetchImpl,
    });
    const result = await generator.generate(input, dataset.id);
    expect(resolve).toHaveBeenCalledWith(dataset.projectId, input.modelConnectionId);
    expect(result).toMatchObject({
      source: "ai_generated",
      generationProvenance: { modelConnectionId: "connection-1" },
    });
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${connection.apiKey}`,
    );
  });

  it("does not fall back to a global key for disabled or foreign-project connections", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const generator = createManagedDatasetCaseGenerator({
      datasets: { getById: vi.fn(() => Promise.resolve(dataset)) },
      connections: { resolve: vi.fn(() => Promise.resolve(null)) },
      production: true,
      allowedHosts: ["models.example.com"],
      timeoutMs: 1_000,
      fetchImpl,
    });
    await expect(generator.generate(input, dataset.id)).rejects.toMatchObject({
      code: "MODEL_CONNECTION_UNAVAILABLE",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps concurrent paid generation across managed connections", async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const generator = createManagedDatasetCaseGenerator({
      datasets: { getById: vi.fn(() => Promise.resolve(dataset)) },
      connections: { resolve: vi.fn(() => Promise.resolve(connection)) },
      production: true,
      allowedHosts: ["models.example.com"],
      timeoutMs: 1_000,
      fetchImpl: vi.fn<typeof fetch>(async () => (await gate).clone()),
    });
    const first = generator.generate(input, dataset.id);
    const second = generator.generate(input, dataset.id);
    await expect(generator.generate(input, dataset.id)).rejects.toMatchObject({
      code: "DATASET_GENERATION_BUSY",
    });
    release(output());
    await Promise.all([first, second]);
  });
});
