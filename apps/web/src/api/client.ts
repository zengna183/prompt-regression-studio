import type {
  CreateProject,
  CreatePrompt,
  CreatePromptVersion,
  CreateDataset,
  Dataset,
  DatasetVersion,
  DatasetImportPreviewRequest,
  DatasetImportRequest,
  DatasetImportPreview,
  GenerateDatasetCasesRequest,
  ReviewDatasetVersionRequest,
  EvaluationCase,
  Project,
  Prompt,
  PromptVersion,
  EvaluationFramework,
  FrameworkVersion,
  CreateFramework,
  CreateFrameworkVersion,
  CreateDatasetVersion,
  Experiment,
  ExperimentDetail,
  ExperimentComparison,
  CreateExperiment,
  StartExperiment,
  StartedExperiment,
  Ablation,
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
import { parseImportPreview } from "../lib/datasetImport";

const configuredBaseUrl = import.meta.env.VITE_API_URL?.trim();
const API_BASE_URL = (configuredBaseUrl || "http://localhost:4000").replace(/\/$/, "");

// An administrator token is session-only. Never persist it or bake it into the bundle.
let sessionToken = "";
let sessionExpired: (() => void) | undefined;
export function onSessionExpired(handler: (() => void) | undefined) {
  sessionExpired = handler;
}
export interface AccountIdentity {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}
export type ProjectRole = "owner" | "editor" | "viewer";
export interface ProjectMember {
  userId: string;
  email: string;
  displayName: string;
  role: ProjectRole;
  disabledAt: string | null;
}
export function setApiToken(value: string) {
  sessionToken = value.trim();
}

export interface ModelConnection {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  allowedModels: string[];
  supportsSeed: boolean;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface NewModelConnection {
  name: string;
  baseUrl: string;
  allowedModels: string[];
  apiKey: string;
  supportsSeed: boolean;
}
const projectPath = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;
const experimentPath = (projectId: string, id: string) =>
  `${projectPath(projectId)}/experiments/${encodeURIComponent(id)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

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
  const requestToken = sessionToken;
  let response: Response;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (requestToken) headers.set("Authorization", `Bearer ${requestToken}`);
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
    if (
      response.status === 401 &&
      requestToken &&
      requestToken === sessionToken &&
      !["/v1/auth/login", "/v1/auth/password"].includes(path)
    )
      sessionExpired?.();
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
    const hints: Record<string, string> = {
      INVALID_CREDENTIALS: "邮箱或密码不正确，或账号已停用。",
      LAST_PROJECT_OWNER: "项目至少需要一名负责人，请先指定另一名负责人。",
      LAST_ADMIN: "不能停用最后一名平台管理员。",
      ACCOUNT_EMAIL_EXISTS: "这个邮箱已有账号，请直接添加为项目成员。",
      ACCOUNT_NOT_FOUND: "未找到可用账号，请先联系平台管理员创建这个邮箱的账号。",
      INVALID_ACCOUNT_INPUT: "请检查邮箱、姓名和密码长度（15～128 个字符）。",
      INVALID_MODEL_CONNECTION:
        "模型连接配置无效。请检查地址、模型名称，以及管理员设置的供应商地址白名单。",
    };
    const message =
      (error.code && hints[error.code]) ||
      (
        {
          401: "访问凭证无效或已失效，请通过页面顶部重新设置。",
          403: "当前访问凭证没有执行此操作的权限，请联系管理员。",
          429: "请求过于频繁或当前任务已满，请稍后重试。",
        } as Record<number, string>
      )[error.status] ||
      error.message;
    return error.requestId ? `${message}（请求编号：${error.requestId}）` : message;
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
  async authStatus(signal?: AbortSignal): Promise<{ mode: "legacy" | "team" }> {
    return unwrapEntity(await request("/v1/auth/status", signal ? { signal } : {}));
  },
  async login(
    email: string,
    password: string,
  ): Promise<{ user: AccountIdentity; token: string; expiresAt: string }> {
    return unwrapEntity(await request("/v1/auth/login", post({ email, password })));
  },
  async logout(): Promise<void> {
    await request("/v1/auth/logout", post());
  },
  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    await request("/v1/auth/password", post({ currentPassword, nextPassword }));
  },
  async listUsers(
    signal?: AbortSignal,
  ): Promise<(AccountIdentity & { disabledAt: string | null })[]> {
    return unwrapList(await request("/v1/auth/users", signal ? { signal } : {}));
  },
  async createUser(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<AccountIdentity> {
    return unwrapEntity(await request("/v1/auth/users", post(input)));
  },
  async disableUser(id: string): Promise<void> {
    await request(`/v1/auth/users/${encodeURIComponent(id)}/disable`, post());
  },
  async projectAccess(id: string, signal?: AbortSignal): Promise<{ role: ProjectRole }> {
    return unwrapEntity(await request(`${projectPath(id)}/access`, signal ? { signal } : {}));
  },
  async listMembers(id: string, signal?: AbortSignal): Promise<ProjectMember[]> {
    return unwrapList(await request(`${projectPath(id)}/members`, signal ? { signal } : {}));
  },
  async setMember(
    id: string,
    input: { email: string; role: ProjectRole } | { userId: string; role: ProjectRole | null },
  ): Promise<void> {
    await request(`${projectPath(id)}/members`, post(input));
  },
  async listModelConnections(projectId: string, signal?: AbortSignal): Promise<ModelConnection[]> {
    return unwrapList<ModelConnection>(
      await request(`${projectPath(projectId)}/model-connections`, signal ? { signal } : {}),
    );
  },
  async createModelConnection(
    projectId: string,
    input: NewModelConnection,
  ): Promise<ModelConnection> {
    return unwrapEntity<ModelConnection>(
      await request(`${projectPath(projectId)}/model-connections`, post(input)),
    );
  },
  async rotateModelKey(projectId: string, id: string, apiKey: string): Promise<ModelConnection> {
    return unwrapEntity<ModelConnection>(
      await request(
        `${projectPath(projectId)}/model-connections/${encodeURIComponent(id)}/rotate`,
        post({ apiKey }),
      ),
    );
  },
  async disableModelConnection(projectId: string, id: string): Promise<ModelConnection> {
    return unwrapEntity<ModelConnection>(
      await request(
        `${projectPath(projectId)}/model-connections/${encodeURIComponent(id)}/disable`,
        post(),
      ),
    );
  },
  async testModelConnection(
    projectId: string,
    id: string,
  ): Promise<{ reachable: boolean; code: string }> {
    return unwrapEntity(
      await request(
        `${projectPath(projectId)}/model-connections/${encodeURIComponent(id)}/test`,
        post(),
      ),
    );
  },
  async listFrameworks(projectId: string, signal?: AbortSignal): Promise<EvaluationFramework[]> {
    return unwrapList(
      await request(`${projectPath(projectId)}/frameworks`, signal ? { signal } : {}),
    );
  },
  async createFramework(projectId: string, input: CreateFramework): Promise<EvaluationFramework> {
    return unwrapEntity(await request(`${projectPath(projectId)}/frameworks`, post(input)));
  },
  async listFrameworkVersions(id: string, signal?: AbortSignal): Promise<FrameworkVersion[]> {
    return unwrapList(
      await request(`/v1/frameworks/${encodeURIComponent(id)}/versions`, signal ? { signal } : {}),
    );
  },
  async createFrameworkVersion(
    id: string,
    input: CreateFrameworkVersion,
  ): Promise<FrameworkVersion> {
    return unwrapEntity(
      await request(`/v1/frameworks/${encodeURIComponent(id)}/versions`, post(input)),
    );
  },
  async publishFrameworkVersion(id: string): Promise<FrameworkVersion> {
    return unwrapEntity(
      await request(`/v1/framework-versions/${encodeURIComponent(id)}/publish`, post()),
    );
  },
  async createDatasetVersion(id: string, input: CreateDatasetVersion): Promise<DatasetVersion> {
    return unwrapEntity(
      await request(`/v1/datasets/${encodeURIComponent(id)}/versions`, post(input)),
    );
  },
  async listExperiments(projectId: string, signal?: AbortSignal): Promise<Experiment[]> {
    return unwrapList(
      await request(`${projectPath(projectId)}/experiments`, signal ? { signal } : {}),
    );
  },
  async createExperiment(projectId: string, input: CreateExperiment): Promise<Experiment> {
    return unwrapEntity(await request(`${projectPath(projectId)}/experiments`, post(input)));
  },
  async getExperiment(
    projectId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<ExperimentDetail> {
    return unwrapEntity(await request(experimentPath(projectId, id), signal ? { signal } : {}));
  },
  async startExperiment(
    projectId: string,
    id: string,
    input: StartExperiment,
  ): Promise<StartedExperiment> {
    return unwrapEntity(await request(`${experimentPath(projectId, id)}/start`, post(input)));
  },
  async cancelExperiment(projectId: string, id: string): Promise<Experiment> {
    return unwrapEntity(await request(`${experimentPath(projectId, id)}/cancel`, post()));
  },
  async compareExperiment(
    projectId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<ExperimentComparison> {
    return unwrapEntity(
      await request(`${experimentPath(projectId, id)}/comparison`, signal ? { signal } : {}),
    );
  },
  async diagnoseExperiment(
    projectId: string,
    id: string,
    candidatePromptVersionId: string,
  ): Promise<DiagnosisReport> {
    return parseDiagnosisReport(
      unwrapEntity(
        await request(
          `${experimentPath(projectId, id)}/diagnoses`,
          post({ candidatePromptVersionId, repetition: 1, includeAblations: true }),
        ),
      ),
    );
  },
  async listAblations(projectId: string, id: string, signal?: AbortSignal): Promise<Ablation[]> {
    return unwrapList(
      await request(`${experimentPath(projectId, id)}/ablations`, signal ? { signal } : {}),
    );
  },
  async createAblation(
    projectId: string,
    id: string,
    candidatePromptVersionId: string,
    blockId: string,
  ): Promise<Ablation> {
    return unwrapEntity(
      await request(
        `${experimentPath(projectId, id)}/ablations`,
        post({ candidatePromptVersionId, blockId }),
      ),
    );
  },
  async datasetGenerationAvailability(signal?: AbortSignal): Promise<{ enabled: boolean }> {
    const payload = await request(
      "/v1/datasets/generation-availability",
      signal ? { signal } : undefined,
    );
    if (!isRecord(payload) || typeof payload.enabled !== "boolean")
      throw new ApiError("服务端返回的生成配置不正确", 502, "INVALID_RESPONSE");
    return { enabled: payload.enabled };
  },
  async listDatasets(projectId: string, signal?: AbortSignal): Promise<Dataset[]> {
    return unwrapList<Dataset>(
      await request(
        `/v1/projects/${encodeURIComponent(projectId)}/datasets`,
        signal ? { signal } : undefined,
      ),
    );
  },
  async createDataset(projectId: string, input: CreateDataset): Promise<Dataset> {
    return unwrapEntity<Dataset>(
      await request(`/v1/projects/${encodeURIComponent(projectId)}/datasets`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },
  async listDatasetVersions(datasetId: string, signal?: AbortSignal): Promise<DatasetVersion[]> {
    return unwrapList<DatasetVersion>(
      await request(
        `/v1/datasets/${encodeURIComponent(datasetId)}/versions`,
        signal ? { signal } : undefined,
      ),
    );
  },
  async previewDatasetImport(
    datasetId: string,
    input: DatasetImportPreviewRequest,
    signal?: AbortSignal,
  ): Promise<DatasetImportPreview> {
    return parseImportPreview(
      await request(`/v1/datasets/${encodeURIComponent(datasetId)}/import-preview`, {
        method: "POST",
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      }),
    );
  },
  async importDataset(
    datasetId: string,
    input: DatasetImportRequest,
    signal?: AbortSignal,
  ): Promise<DatasetVersion> {
    return unwrapEntity<DatasetVersion>(
      await request(`/v1/datasets/${encodeURIComponent(datasetId)}/import`, {
        method: "POST",
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      }),
    );
  },
  async generateDatasetCases(
    datasetId: string,
    input: GenerateDatasetCasesRequest,
  ): Promise<DatasetVersion> {
    return unwrapEntity<DatasetVersion>(
      await request(`/v1/datasets/${encodeURIComponent(datasetId)}/generate`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },
  async listDatasetCases(versionId: string): Promise<EvaluationCase[]> {
    return unwrapList<EvaluationCase>(
      await request(`/v1/dataset-versions/${encodeURIComponent(versionId)}/cases`),
    );
  },
  async reviewDatasetVersion(
    versionId: string,
    input: ReviewDatasetVersionRequest,
  ): Promise<DatasetVersion> {
    return unwrapEntity<DatasetVersion>(
      await request(`/v1/dataset-versions/${encodeURIComponent(versionId)}/review`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },
  async publishDatasetVersion(versionId: string): Promise<DatasetVersion> {
    return unwrapEntity<DatasetVersion>(
      await request(`/v1/dataset-versions/${encodeURIComponent(versionId)}/publish`, {
        method: "POST",
      }),
    );
  },
  async diagnose(
    bundle: CanonicalRegressionBundle,
    signal?: AbortSignal,
    projectId?: string,
  ): Promise<DiagnosisReport> {
    const payload = await request(
      `/v1/diagnoses${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(bundle),
        ...(signal ? { signal } : {}),
      },
    );
    return parseDiagnosisReport(unwrapEntity<unknown>(payload));
  },

  async listDiagnoses(
    signal?: AbortSignal,
    projectId?: string,
  ): Promise<readonly DiagnosisRunSummary[]> {
    const payload = await request(
      `/v1/diagnoses?limit=25${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
      signal ? { signal } : undefined,
    );
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
