import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ChatCompletionResponse } from "@prompt-regression/model-provider";

import { createDatasetCaseGenerator } from "./dataset-generation.js";

const brief = "测试客服对退款和政策不明确问题的回答";
const response = (text: string): ChatCompletionResponse => ({
  provider: "openai-compatible",
  model: "resolved-model",
  text,
  usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
  providerRequestId: "req-123",
  rawResponse: { secret: "must-not-be-saved" },
});

describe("AI dataset case generation", () => {
  it("creates a traceable draft payload without trusting model-owned IDs or raw responses", async () => {
    const complete = vi.fn().mockResolvedValue(
      response(
        JSON.stringify({
          cases: [
            {
              name: "超期退款",
              input: "过期了还能退吗？",
              expectedOutput: "先核实政策，不应承诺退款",
            },
            {
              name: "政策模糊",
              input: "规则没写清楚怎么办？",
              expectedOutput: "说明不确定性并建议人工核实",
            },
          ],
        }),
      ),
    );
    const generator = createDatasetCaseGenerator({ complete }, "configured-model");
    const result = await generator.generate({ brief: ` ${brief} `, count: 2 });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: "configured-model", maxTokens: 4096 }),
    );
    expect(result).toMatchObject({
      source: "ai_generated",
      cases: [{ caseKey: "ai-001", input: "过期了还能退吗？" }, { caseKey: "ai-002" }],
      generationProvenance: {
        model: "resolved-model",
        requestedModel: "configured-model",
        brief,
        requestedCount: 2,
        providerRequestId: "req-123",
        generator: "dataset-cases/v1",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-saved");
    expect(result.generationProvenance).toHaveProperty(
      "requestHash",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  it.each([
    '{"cases":[]}',
    '{"cases":[{"name":"x","input":"same","expectedOutput":"x"},{"name":"y","input":"same","expectedOutput":"y"}]}',
    '{"cases":[{"name":"x","input":"ok","expectedOutput":"ok","source":"trusted"}]}',
    "not json",
  ])("rejects unsafe model output without producing a draft", async (text) => {
    const generator = createDatasetCaseGenerator(
      { complete: vi.fn().mockResolvedValue(response(text)) },
      "model",
    );
    await expect(generator.generate({ brief, count: 2 })).rejects.toMatchObject({
      code: "DATASET_GENERATION_INVALID_OUTPUT",
    });
  });

  it("does not leak model-provider errors and caps concurrent paid calls", async () => {
    const failure = createDatasetCaseGenerator(
      {
        complete: vi
          .fn()
          .mockRejectedValue(new ProviderError("PROVIDER_AUTHENTICATION_FAILED", "private-key")),
      },
      "model",
    );
    await expect(failure.generate({ brief, count: 1 })).rejects.toMatchObject({
      statusCode: 502,
      code: "DATASET_GENERATION_PROVIDER_FAILED",
    });
    let release!: (value: ChatCompletionResponse) => void;
    const pending = new Promise<ChatCompletionResponse>((resolve) => {
      release = resolve;
    });
    const generator = createDatasetCaseGenerator({ complete: vi.fn(() => pending) }, "model");
    const first = generator.generate({ brief, count: 1 });
    const second = generator.generate({ brief, count: 1 });
    await expect(generator.generate({ brief, count: 1 })).rejects.toMatchObject({
      statusCode: 429,
      code: "DATASET_GENERATION_BUSY",
    });
    release(response('{"cases":[{"name":"x","input":"unique","expectedOutput":"answer"}]}'));
    await Promise.all([first, second]);
  });
});
