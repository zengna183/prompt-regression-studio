import type {
  CreateProject,
  CreatePrompt,
  CreatePromptVersion,
  Project,
  Prompt,
  PromptVersion,
} from "@ai-chat-eval/contracts";

import type {
  CanonicalRegressionBundle,
  DiagnosisReport,
  DiagnosisRunDetail,
  DiagnosisRunSummary,
} from "../diagnosis/types";
import {
  parseDiagnosisReport,
  parseDiagnosisRunDetail,
  parseDiagnosisRunList,
} from "../diagnosis/validation";

const configuredBaseUrl = import.meta.env.VITE_API_URL?.trim();
const API_BASE_URL = (configuredBaseUrl || "http://localhost:4000").replace(/\/$/, "");

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  requestId?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapEntity<T>(payload: unknown): T {
  if (isRecord(payload) && "data" in payload) {
    return payload.data as T;
  }
  return payload as T;
}

function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return payload.data as T[];
  }
  if (isRecord(payload) && Array.isArray(payload.items)) {
    return payload.items as T[];
  }
  throw new ApiError("服务端返回了无法识别的列表格式", 502, "INVALID_RESPONSE");
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    return text || undefined;
  }
  return response.json() as Promise<unknown>;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError("无法连接评测服务，请确认 API 已启动", 0, "NETWORK_ERROR");
  }

  const payload = await readPayload(response);

  if (!response.ok) {
    const body: ApiErrorBody = isRecord(payload) ? payload : {};
    const message =
      typeof body.message === "string" ? body.message : `请求失败（${response.status}）`;
    const code = typeof body.code === "string" ? body.code : undefined;
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    throw new ApiError(message, response.status, code, requestId);
  }

  return payload;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message}（请求编号：${error.requestId}）` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生了未知错误，请稍后重试";
}

export function getDiagnosisErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return getErrorMessage(error);

  const message = (() => {
    switch (error.code) {
      case "DIAGNOSIS_ENGINE_INVALID_INPUT":
        return "评测包未通过完整校验。请确认基线与候选结果一一对应，且模型和评判配置没有变化。";
      case "DIAGNOSIS_ENGINE_INPUT_TOO_LARGE":
        return "评测包超过服务端大小限制，请缩小数据集或使用命令行诊断。";
      case "DIAGNOSIS_ENGINE_TIMEOUT":
        return "诊断运行超时。服务可能繁忙，可以稍后重试。";
      case "DIAGNOSIS_CAPACITY_EXCEEDED":
        return "当前诊断任务已满，请稍后重试。";
      case "DIAGNOSIS_ENGINE_START_FAILED":
        return "诊断引擎暂时不可用，请确认 Python Core 已正确安装。";
      case "DIAGNOSIS_ENGINE_ABORTED":
        return "诊断请求已取消。";
      case "DIAGNOSIS_ENGINE_INVALID_CONFIGURATION":
        return "诊断服务配置有误，请联系平台维护者。";
      case "DIAGNOSIS_ENGINE_PROCESS_FAILED":
      case "DIAGNOSIS_ENGINE_IO_FAILED":
      case "DIAGNOSIS_ENGINE_INVALID_OUTPUT":
      case "DIAGNOSIS_ENGINE_OUTPUT_TOO_LARGE":
      case "DIAGNOSIS_ENGINE_STDERR_TOO_LARGE":
        return "诊断引擎没有返回可用报告，请重试；若持续发生，请联系平台维护者。";
      default:
        return error.message;
    }
  })();

  return error.requestId ? `${message}（请求编号：${error.requestId}）` : message;
}

export const api = {
  async diagnose(
    bundle: CanonicalRegressionBundle,
    signal?: AbortSignal,
  ): Promise<DiagnosisReport> {
    const payload = await request("/v1/diagnoses", {
      method: "POST",
      body: JSON.stringify(bundle),
      ...(signal ? { signal } : {}),
    });
    return parseDiagnosisReport(unwrapEntity<unknown>(payload));
  },

  async listDiagnoses(signal?: AbortSignal): Promise<readonly DiagnosisRunSummary[]> {
    const payload = await request("/v1/diagnoses?limit=25", signal ? { signal } : undefined);
    return parseDiagnosisRunList(payload);
  },

  async getDiagnosis(id: string, signal?: AbortSignal): Promise<DiagnosisRunDetail> {
    const payload = await request(
      `/v1/diagnoses/${encodeURIComponent(id)}`,
      signal ? { signal } : undefined,
    );
    return parseDiagnosisRunDetail(payload);
  },

  async listProjects(signal?: AbortSignal): Promise<Project[]> {
    return unwrapList<Project>(await request("/v1/projects", signal ? { signal } : undefined));
  },

  async createProject(input: CreateProject): Promise<Project> {
    return unwrapEntity<Project>(
      await request("/v1/projects", { method: "POST", body: JSON.stringify(input) }),
    );
  },

  async listPrompts(projectId: string, signal?: AbortSignal): Promise<Prompt[]> {
    return unwrapList<Prompt>(
      await request(
        `/v1/projects/${encodeURIComponent(projectId)}/prompts`,
        signal ? { signal } : undefined,
      ),
    );
  },

  async createPrompt(projectId: string, input: CreatePrompt): Promise<Prompt> {
    return unwrapEntity<Prompt>(
      await request(`/v1/projects/${encodeURIComponent(projectId)}/prompts`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },

  async listPromptVersions(promptId: string, signal?: AbortSignal): Promise<PromptVersion[]> {
    return unwrapList<PromptVersion>(
      await request(
        `/v1/prompts/${encodeURIComponent(promptId)}/versions`,
        signal ? { signal } : undefined,
      ),
    );
  },

  async createPromptVersion(promptId: string, input: CreatePromptVersion): Promise<PromptVersion> {
    return unwrapEntity<PromptVersion>(
      await request(`/v1/prompts/${encodeURIComponent(promptId)}/versions`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },

  async publishPromptVersion(versionId: string): Promise<PromptVersion> {
    return unwrapEntity<PromptVersion>(
      await request(`/v1/prompt-versions/${encodeURIComponent(versionId)}/publish`, {
        method: "POST",
      }),
    );
  },
};
