import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleClient, ProviderError } from "./index.js";

type FetchInput = Parameters<typeof fetch>[0];

const validKey = "provider-test-key-that-is-long-enough";
const validRequest = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "hello" }],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenAICompatibleClient", () => {
  it("sends a bounded OpenAI-compatible request and normalizes usage", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn((input: FetchInput, init?: RequestInit) => {
      calledUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calledInit = init;
      return Promise.resolve(
        jsonResponse({
          id: "chatcmpl_test",
          model: "test-model-v2",
          choices: [{ message: { content: "world" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
    });
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com/v1/?ignored=query",
      apiKey: validKey,
      fetchImpl,
    });

    const result = await client.complete(validRequest);

    expect(calledUrl).toBe("https://api.example.com/v1/chat/completions");
    expect(calledInit?.method).toBe("POST");
    expect(new Headers(calledInit?.headers).get("authorization")).toBe(`Bearer ${validKey}`);
    const requestBody = typeof calledInit?.body === "string" ? calledInit.body : "";
    expect(JSON.parse(requestBody)).toEqual(validRequest);
    expect(result).toMatchObject({
      provider: "openai-compatible",
      model: "test-model-v2",
      text: "world",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      providerRequestId: "chatcmpl_test",
    });
  });

  it("supports a default model and strips unknown request options", async () => {
    let sentBody = "";
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com",
      apiKey: validKey,
      defaultModel: "default-model",
      fetchImpl: vi.fn((_input: FetchInput, init?: RequestInit) => {
        sentBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
      }),
    });

    await client.complete({ messages: validRequest.messages, temperature: 0.2, maxTokens: 100 });
    expect(JSON.parse(sentBody)).toEqual({
      model: "default-model",
      messages: validRequest.messages,
      temperature: 0.2,
      max_tokens: 100,
    });
  });

  it.each([
    ["http://api.example.com", true, false],
    ["http://127.0.0.1:8080", false, false],
    ["https://localhost:8443", false, false],
    ["https://user:password@api.example.com", false, false],
  ] as const)("rejects unsafe provider URL %s", (baseUrl, production, allowPrivateNetwork) => {
    expect(
      () =>
        new OpenAICompatibleClient({ baseUrl, apiKey: validKey, production, allowPrivateNetwork }),
    ).toThrow(ProviderError);
  });

  it("allows an explicitly private development endpoint but never in production", () => {
    expect(
      () =>
        new OpenAICompatibleClient({
          baseUrl: "http://127.0.0.1:8080",
          apiKey: validKey,
          allowPrivateNetwork: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new OpenAICompatibleClient({
          baseUrl: "https://127.0.0.1:8443",
          apiKey: validKey,
          production: true,
          allowPrivateNetwork: true,
        }),
    ).toThrow(/HTTPS|private/);
  });

  it("classifies provider failures without exposing provider response bodies", async () => {
    const fetchImpl: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com",
      apiKey: validKey,
      fetchImpl,
    });

    const error = await client.complete(validRequest).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "PROVIDER_AUTHENTICATION_FAILED", retryable: false });
    expect(String(error)).not.toContain("secret provider detail");
    expect(String(error)).not.toContain(validKey);
  });

  it("rejects oversized responses before parsing them", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com",
      apiKey: validKey,
      maxResponseBytes: 1_024,
      fetchImpl: vi.fn(() => Promise.resolve(new Response("x".repeat(2_000), { status: 200 }))),
    });

    await expect(client.complete(validRequest)).rejects.toMatchObject({
      code: "PROVIDER_BAD_RESPONSE",
    });
  });

  it("maps caller cancellation separately from timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: typeof fetch = vi.fn((_input: FetchInput, init?: RequestInit) => {
      if (init?.signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: "never" } }] }));
    });
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.example.com",
      apiKey: validKey,
      fetchImpl,
    });

    await expect(
      client.complete({ ...validRequest, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "PROVIDER_CANCELLED",
    });
  });
});
