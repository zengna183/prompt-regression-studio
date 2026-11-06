// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExperimentCasePage } from "@ai-chat-eval/contracts";
import { api } from "../api/client";
import { ExperimentCases } from "./ExperimentCases";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const props = { projectId: "project", experimentId: "experiment", repetitions: 2 };
function fixture(): ExperimentCasePage {
  return {
    experimentId: "experiment",
    offset: 0,
    limit: 5,
    repetition: 1,
    total: 6,
    promptVersions: [
      { promptVersionId: "baseline", label: "原版", isBaseline: true },
      { promptVersionId: "candidate", label: "新版", isBaseline: false },
    ],
    items: [
      {
        caseId: "one",
        caseKey: "用例一",
        name: null,
        input: { question: "如何退款" },
        expectedOutput: "核实订单",
        results: [
          {
            promptVersionId: "baseline",
            generationRunId: "g",
            evaluationRunId: "e",
            model: "model",
            evaluationStatus: "succeeded",
            failureCode: null,
            failureMessage: null,
            output: {
              status: "succeeded",
              outputText: "<img src=x onerror=alert(1)>",
              errorCode: null,
              errorMessage: null,
            },
            scores: [
              {
                kind: "overall",
                metricKey: "__overall__",
                metricName: "综合分",
                score: 0,
                minScore: 0,
                maxScore: 5,
                normalizedScore: 0,
                passed: false,
                confidence: null,
                rationale: "缺少订单核实",
                evidence: ["退款"],
              },
            ],
          },
          {
            promptVersionId: "candidate",
            generationRunId: "g2",
            evaluationRunId: "e2",
            model: "model",
            evaluationStatus: "failed",
            failureCode: "PROVIDER_ERROR",
            failureMessage: "Timeout",
            output: {
              status: "failed",
              outputText: null,
              errorCode: "PROVIDER_TIMEOUT",
              errorMessage: "超时",
            },
            scores: [],
          },
        ],
      },
    ],
  };
}

describe("case evidence inspection", () => {
  it("distinguishes a real zero from a missing grade and renders model output as inert text", async () => {
    vi.spyOn(api, "listExperimentCases").mockResolvedValue(fixture());
    const view = render(<ExperimentCases {...props} />);
    await userEvent.setup().click(await screen.findByText("用例一"));
    const original = within(screen.getByRole("region", { name: "原版的用例结果" }));
    const candidate = within(screen.getByRole("region", { name: "新版的用例结果" }));
    expect(original.getByText("综合评分：0.0%")).toBeTruthy();
    expect(candidate.getByText("综合评分：暂无分数")).toBeTruthy();
    expect(candidate.getByText(/PROVIDER_TIMEOUT/)).toBeTruthy();
    expect(original.getByText("评分理由：缺少订单核实")).toBeTruthy();
    expect(original.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    await userEvent.setup().click(original.getByText("查看评分引用的证据"));
    expect(original.getByText(/"退款"/)).toBeTruthy();
  });

  it("pages by case, resets the page on repetition changes and removes stale evidence", async () => {
    const first = fixture();
    const next = {
      ...first,
      offset: 5,
      items: [{ ...first.items[0]!, caseId: "six", caseKey: "用例六" }],
    };
    const load = vi
      .spyOn(api, "listExperimentCases")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce({ ...first, repetition: 2, items: [] });
    render(<ExperimentCases {...props} />);
    const user = userEvent.setup();
    await screen.findByText("用例一");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "上一页用例" }).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "下一页用例" }));
    await screen.findByText("用例六");
    expect(load.mock.calls[1]?.[2]).toEqual({ offset: 5, limit: 5, repetition: 1 });
    expect(screen.queryByText("用例一")).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "查看第几次评测" }), "2");
    await screen.findByText("这一页没有用例。");
    expect(load.mock.calls[2]?.[2]).toEqual({ offset: 0, limit: 5, repetition: 2 });
    expect(screen.queryByText("用例六")).toBeNull();
    expect(load.mock.calls[1]?.[3]?.aborted).toBe(true);
  });

  it("shows a retryable error and keeps late responses from the old repetition out", async () => {
    let finish!: (value: ExperimentCasePage) => void;
    const load = vi
      .spyOn(api, "listExperimentCases")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce({ ...fixture(), repetition: 2, items: [] });
    render(<ExperimentCases {...props} />);
    const user = userEvent.setup();
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    await user.selectOptions(screen.getByRole("combobox", { name: "查看第几次评测" }), "2");
    await screen.findByRole("alert");
    finish(fixture());
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("这一页没有用例。");
    expect(screen.queryByText("用例一")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
