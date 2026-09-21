export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ChatCompletionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface ChatCompletionResponse {
  readonly provider: "openai-compatible";
  readonly model: string;
  readonly text: string;
  readonly usage: ChatCompletionUsage;
  readonly providerRequestId: string | null;
  readonly rawResponse: unknown;
}

export type ProviderErrorCode =
  | "PROVIDER_INVALID_CONFIGURATION"
  | "PROVIDER_INVALID_REQUEST"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CANCELLED"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_BAD_RESPONSE"
  | "PROVIDER_SERVER_ERROR";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | null;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly statusCode?: number | null } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? null;
  }
}

export interface OpenAICompatibleClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel?: string;
  readonly production?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

interface ResolvedOptions {
  readonly endpoint: URL;
  readonly apiKey: string;
  readonly defaultModel: string | undefined;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly fetchImpl: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const privateHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
]);

export class OpenAICompatibleClient {
  readonly #options: ResolvedOptions;

  constructor(options: OpenAICompatibleClientOptions) {
    this.#options = resolveOptions(options);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = createRequestBody(request, this.#options.defaultModel);
    const serialized = JSON.stringify(body);
    const requestBytes = Buffer.byteLength(serialized, "utf8");
    if (requestBytes > this.#options.maxRequestBytes) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "The model request exceeds the configured size limit.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), this.#options.timeoutMs);
    timeout.unref?.();
    const abortFromCaller = (): void => controller.abort("cancelled");
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (request.signal?.aborted === true) controller.abort("cancelled");

    let response: Response;
    try {
      response = await this.#options.fetchImpl(this.#options.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.#options.apiKey}`,
        },
        body: serialized,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
      if (request.signal?.aborted === true) {
        throw new ProviderError("PROVIDER_CANCELLED", "The model request was cancelled.");
      }
      if (controller.signal.aborted) {
        throw new ProviderError("PROVIDER_TIMEOUT", "The model request timed out.", {
          retryable: true,
        });
      }
      throw new ProviderError(
        "PROVIDER_NETWORK_ERROR",
        "The model provider could not be reached.",
        {
          retryable: true,
        },
      );
    }

    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromCaller);
    if (request.signal?.aborted === true) {
      throw new ProviderError("PROVIDER_CANCELLED", "The model request was cancelled.");
    }
    if (controller.signal.aborted) {
      throw new ProviderError("PROVIDER_TIMEOUT", "The model request timed out.", {
        retryable: true,
      });
    }
    const responseText = await readResponseText(response, this.#options.maxResponseBytes);
    if (!response.ok) throw providerResponseError(response.status, responseText);

    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      throw new ProviderError("PROVIDER_BAD_RESPONSE", "The model provider returned invalid JSON.");
    }
    return parseCompletionResponse(
      payload,
      request.model ?? this.#options.defaultModel ?? "unknown",
    );
  }
}

function resolveOptions(options: OpenAICompatibleClientOptions): ResolvedOptions {
  const endpoint = parseProviderUrl(
    options.baseUrl,
    options.production ?? false,
    options.allowPrivateNetwork ?? false,
  );
  if (!isNonEmptySecret(options.apiKey, 8, 512)) {
    throw new ProviderError(
      "PROVIDER_INVALID_CONFIGURATION",
      "The model provider API key is invalid.",
    );
  }
  const defaultModel =
    options.defaultModel === undefined ? undefined : validateModel(options.defaultModel);
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1_000,
    MAX_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxRequestBytes = boundedInteger(
    options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    1_024,
    MAX_REQUEST_BYTES,
    "maxRequestBytes",
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1_024,
    MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  return {
    endpoint,
    apiKey: options.apiKey,
    defaultModel,
    timeoutMs,
    maxRequestBytes,
    maxResponseBytes,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

function parseProviderUrl(raw: string, production: boolean, allowPrivateNetwork: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_CONFIGURATION", "The model provider URL is invalid.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !production)) {
    throw new ProviderError(
      "PROVIDER_INVALID_CONFIGURATION",
      "The model provider URL must use HTTPS outside local development.",
    );
  }
  if (url.username || url.password) {
    throw new ProviderError(
      "PROVIDER_INVALID_CONFIGURATION",
      "The model provider URL must not contain credentials or an empty port.",
    );
  }
  if ((production || !allowPrivateNetwork) && isPrivateHost(url.hostname)) {
    throw new ProviderError(
      "PROVIDER_INVALID_CONFIGURATION",
      "The model provider URL points to a private or local network address.",
    );
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = basePath.endsWith("/v1")
    ? `${basePath}/chat/completions`
    : `${basePath}/v1/chat/completions`;
  url.search = "";
  url.hash = "";
  return url;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (privateHostnames.has(host)) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "127.0.0.1") return true;
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function createRequestBody(request: ChatCompletionRequest, defaultModel: string | undefined) {
  const model = validateModel(request.model || defaultModel || "");
  if (
    !Array.isArray(request.messages) ||
    request.messages.length < 1 ||
    request.messages.length > 256
  ) {
    throw new ProviderError(
      "PROVIDER_INVALID_REQUEST",
      "The model request must contain 1-256 messages.",
    );
  }
  const messages = request.messages.map((message: ChatMessage) => {
    if (!message || !["system", "user", "assistant"].includes(message.role)) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "The model request contains an invalid message role.",
      );
    }
    if (
      typeof message.content !== "string" ||
      message.content.length === 0 ||
      message.content.length > 1_000_000
    ) {
      throw new ProviderError("PROVIDER_INVALID_REQUEST", "The model message content is invalid.");
    }
    return { role: message.role, content: message.content };
  });
  const body: Record<string, unknown> = { model, messages };
  if (request.temperature !== undefined) {
    if (
      !Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 2
    ) {
      throw new ProviderError("PROVIDER_INVALID_REQUEST", "temperature must be between 0 and 2.");
    }
    body.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    if (
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > 1_000_000
    ) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "maxTokens is outside the allowed range.",
      );
    }
    body.max_tokens = request.maxTokens;
  }
  return body;
}

function parseCompletionResponse(payload: unknown, requestedModel: string): ChatCompletionResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "The model provider returned no completion choice.",
    );
  }
  const choices = payload.choices as readonly unknown[];
  const first = choices[0];
  const message = isRecord(first) ? first.message : undefined;
  const text = isRecord(message) ? message.content : undefined;
  if (typeof text !== "string" || text.length > 10_000_000) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "The model provider returned invalid completion text.",
    );
  }
  const usage = parseUsage(payload.usage);
  return {
    provider: "openai-compatible",
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    text,
    usage,
    providerRequestId: typeof payload.id === "string" ? payload.id.slice(0, 255) : null,
    rawResponse: payload,
  };
}

function parseUsage(value: unknown): ChatCompletionUsage {
  if (!isRecord(value)) return { inputTokens: null, outputTokens: null, totalTokens: null };
  return {
    inputTokens: safeNonNegativeInteger(value.prompt_tokens),
    outputTokens: safeNonNegativeInteger(value.completion_tokens),
    totalTokens: safeNonNegativeInteger(value.total_tokens),
  };
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function providerResponseError(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      "PROVIDER_AUTHENTICATION_FAILED",
      "The model provider rejected the credentials.",
      {
        statusCode: status,
      },
    );
  }
  if (status === 429) {
    return new ProviderError(
      "PROVIDER_RATE_LIMITED",
      "The model provider rate-limited the request.",
      {
        retryable: true,
        statusCode: status,
      },
    );
  }
  if (status >= 500) {
    return new ProviderError(
      "PROVIDER_SERVER_ERROR",
      "The model provider returned a server error.",
      {
        retryable: true,
        statusCode: status,
      },
    );
  }
  void body;
  return new ProviderError("PROVIDER_INVALID_REQUEST", "The model provider rejected the request.", {
    statusCode: status,
  });
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "The model provider response is too large.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value as Uint8Array;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ProviderError(
          "PROVIDER_BAD_RESPONSE",
          "The model provider response is too large.",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_NETWORK_ERROR",
      "The model provider response could not be read.",
      {
        retryable: true,
      },
    );
  }
  return new TextDecoder().decode(concatBytes(chunks, totalBytes));
}

function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateModel(value: string): string {
  if (value.length < 1 || value.length > 240 || containsUnsafeWhitespace(value)) {
    throw new ProviderError("PROVIDER_INVALID_REQUEST", "The model identifier is invalid.");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProviderError(
      "PROVIDER_INVALID_CONFIGURATION",
      `${name} is outside the allowed range.`,
    );
  }
  return value;
}

function isNonEmptySecret(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && !containsUnsafeWhitespace(value);
}

function containsUnsafeWhitespace(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character.trim() === "" || codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
