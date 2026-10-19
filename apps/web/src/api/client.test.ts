import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalBundleFixture, diagnosisReportFixture } from "../diagnosis/testFixtures";
import { DiagnosisResponseError } from "../diagnosis/validation";
import {
  api,
  ApiError,
  getDiagnosisErrorMessage,
  getErrorMessage,
  onSessionExpired,
  setApiToken,
} from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  setApiToken("");
  onSessionExpired(undefined);
});

describe("会话访问凭证与错误提示", () => {
  it("旧请求的 401 不会撤销后来重新登录的新会话", async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const expired = vi.fn();
    onSessionExpired(expired);
    setApiToken("old-token");
    const pending = api.listProjects();
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
    setApiToken("new-token");
    finish?.(
      new Response(JSON.stringify({ code: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await rejected;
    expect(expired).not.toHaveBeenCalled();
  });
  it("错误的当前密码不撤销仍有效的页面会话", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ code: "INVALID_CREDENTIALS" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const expired = vi.fn();
    onSessionExpired(expired);
    setApiToken("active-token");
    await expect(api.changePassword("wrong", "new long password")).rejects.toMatchObject({
      status: 401,
    });
    expect(expired).not.toHaveBeenCalled();
  });
  it("只在设置后发送凭证，清除后不再附带", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    setApiToken("  session-test-token  ");
    await api.listProjects();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer session-test-token",
    );
    setApiToken("");
    await api.listProjects();
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
  });
  it("将无效凭证翻译成可操作的提示并保留请求编号", () => {
    expect(getErrorMessage(new ApiError("Unauthorized", 401, "UNAUTHORIZED", "req-1"))).toBe(
      "访问凭证无效或已失效，请通过页面顶部重新设置。（请求编号：req-1）",
    );
  });
});

describe("评测集导入 API 客户端", () => {
  it("先获取预览，再带同一指纹保存原始内容并传递取消信号", async () => {
    const preview = {
      previewHash: "a".repeat(64),
      totalRows: 1,
      validRows: 1,
      errorCount: 0,
      canImport: true,
      issuesTruncated: false,
      issues: [],
      previewRows: [{ row: 1, case: { caseKey: "a", input: "你好" } }],
    };
    const saved = { id: "version", status: "draft", caseCount: 1 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse(saved));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const input = { format: "json" as const, content: '[{"input":"你好"}]' };
    const result = await api.previewDatasetImport("dataset", input, controller.signal);
    expect(
      await api.importDataset(
        "dataset",
        { ...input, previewHash: result.previewHash },
        controller.signal,
      ),
    ).toEqual(saved);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/dataset/import-preview"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        signal: controller.signal,
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/dataset/import"),
      expect.objectContaining({
        body: JSON.stringify({ ...input, previewHash: preview.previewHash }),
        signal: controller.signal,
      }),
    );
  });
  it("拒绝畸形预览响应", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ canImport: true })));
    await expect(
      api.previewDatasetImport("dataset", { format: "csv", content: "input\nx" }),
    ).rejects.toThrow("格式不正确");
  });
});

describe("诊断 API 客户端", () => {
  it("向诊断端点发送 canonical bundle，并解析包装后的报告", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return Promise.resolve(jsonResponse({ data: diagnosisReportFixture }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const report = await api.diagnose(canonicalBundleFixture, controller.signal);

    expect(report).toEqual(diagnosisReportFixture);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedInput).toBe("http://localhost:4000/v1/diagnoses");
    expect(capturedInit).toMatchObject({
      method: "POST",
      body: JSON.stringify(canonicalBundleFixture),
      signal: controller.signal,
    });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("把服务繁忙错误转换成可执行的中文提示，并保留请求编号", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            {
              code: "DIAGNOSIS_CAPACITY_EXCEEDED",
              message: "capacity exceeded",
              requestId: "request-007",
            },
            503,
          ),
        ),
      ),
    );

    let thrown: unknown;
    try {
      await api.diagnose(canonicalBundleFixture);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect(getDiagnosisErrorMessage(thrown)).toBe(
      "当前诊断任务已满，请稍后重试。（请求编号：request-007）",
    );
  });

  it("拒绝服务端返回的畸形报告，而不是把未知数据交给界面", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ ...diagnosisReportFixture, evidence: [{}] }))),
    );

    await expect(api.diagnose(canonicalBundleFixture)).rejects.toBeInstanceOf(
      DiagnosisResponseError,
    );
  });

  it("读取诊断历史和已保存报告", async () => {
    const summary = {
      id: "run-1",
      projectId: null,
      bundleId: "bundle_test",
      status: "succeeded",
      inputBundleHash: diagnosisReportFixture.input_bundle_hash,
      reportId: diagnosisReportFixture.report_id,
      failureCode: null,
      failureMessage: null,
      createdAt: "2026-09-14T00:00:00.000Z",
      startedAt: "2026-09-14T00:00:00.000Z",
      completedAt: "2026-09-14T00:00:01.000Z",
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [summary] }))
      .mockResolvedValueOnce(jsonResponse({ ...summary, report: diagnosisReportFixture }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listDiagnoses()).resolves.toEqual([summary]);
    await expect(api.getDiagnosis("run-1")).resolves.toEqual({
      ...summary,
      report: diagnosisReportFixture,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:4000/v1/diagnoses?limit=25");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:4000/v1/diagnoses/run-1");
  });
});

describe("实验诊断按实际验证记录选择证据", () => {
  it.each([
    { links: [], includeAblations: false },
    { links: [{ candidatePromptVersionId: "other" }], includeAblations: false },
    { links: [{ candidatePromptVersionId: "candidate" }], includeAblations: true },
  ])(
    "没有对应验证时先诊断，有对应验证时才读取证据：$includeAblations",
    async ({ links, includeAblations }) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(links))
        .mockResolvedValueOnce(jsonResponse(diagnosisReportFixture));
      vi.stubGlobal("fetch", fetchMock);
      await api.diagnoseExperiment("project", "experiment", "candidate");
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "http://localhost:4000/v1/projects/project/experiments/experiment/ablations",
      );
      expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
        candidatePromptVersionId: "candidate",
        repetition: 1,
        includeAblations,
      });
    },
  );

  it("验证记录读取失败时不能冒充没有验证记录", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ code: "UNAVAILABLE" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      api.diagnoseExperiment("project", "experiment", "candidate"),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("未完成或损坏的验证被拒绝后，不会降级成无证据报告", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ candidatePromptVersionId: "candidate" }]))
      .mockResolvedValueOnce(jsonResponse({ code: "DIAGNOSIS_INPUT_INCOMPLETE" }, 409));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      api.diagnoseExperiment("project", "experiment", "candidate"),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
