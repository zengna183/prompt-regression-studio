import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalBundleFixture, diagnosisReportFixture } from "../diagnosis/testFixtures";
import { DiagnosisResponseError } from "../diagnosis/validation";
import { api, ApiError, getDiagnosisErrorMessage } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
