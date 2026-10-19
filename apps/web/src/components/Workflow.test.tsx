// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CreateProject,
  ExperimentDetail,
  FrameworkVersion,
  Project,
} from "@ai-chat-eval/contracts";
import { App } from "../App";
import { api, setApiToken } from "../api/client";
import { ManualDatasetCases } from "./ManualDatasetCases";
import { ModelWorkspace } from "./ModelWorkspace";
import { FrameworkEditor } from "./FrameworkWorkspace";
import { ExperimentCreate, ExperimentStart } from "./ExperimentForms";
import { ExperimentWorkspace } from "./ExperimentWorkspace";
import { diagnosisReportFixture } from "../diagnosis/testFixtures";
import { CreateProjectForm } from "./CreateForms";

const now = "2026-10-15T00:00:00.000Z";
const project: Project = {
  id: "project",
  name: "测试项目",
  slug: "test",
  description: null,
  createdAt: now,
  updatedAt: now,
};
const connection = {
  id: "generator",
  projectId: project.id,
  name: "生成服务",
  baseUrl: "https://example.com/v1",
  allowedModels: ["model-a"],
  supportsSeed: true,
  disabledAt: null,
  createdAt: now,
  updatedAt: now,
};
const detail: ExperimentDetail = {
  experiment: {
    id: "experiment",
    projectId: project.id,
    datasetVersionId: "dataset",
    frameworkVersionId: "rubric",
    name: "实验",
    description: null,
    status: "draft",
    randomSeed: 42,
    repetitions: 1,
    createdAt: now,
    updatedAt: now,
  },
  costBudget: null,
  promptVersions: [],
  runs: [],
  failureCode: null,
  failureMessage: null,
  startedAt: null,
  completedAt: null,
  progress: {
    plannedRuns: 2,
    createdRuns: 0,
    queuedRuns: 0,
    runningRuns: 0,
    succeededRuns: 0,
    partiallySucceededRuns: 0,
    failedRuns: 0,
    cancelledRuns: 0,
    completedRuns: 0,
    completionRate: 0,
    casesPerRun: 1,
    plannedCaseExecutions: 2,
    completedCaseExecutions: 0,
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setApiToken("");
});

describe("非技术用户真实表单交互（模拟网络边界，不调用付费模型）", () => {
  it("实验计划只可选择已发布版本，并保持基线与候选不同", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") return Promise.resolve(json(detail.experiment));
      const data = path.endsWith("/prompts")
        ? [{ id: "prompt", name: "退款助手" }]
        : path.endsWith("/datasets")
          ? [{ id: "dataset", name: "退款用例" }]
          : path.endsWith("/frameworks")
            ? [{ id: "framework", name: "业务规则" }]
            : path.includes("/prompts/prompt/versions")
              ? [
                  { id: "baseline", version: 1, status: "published" },
                  { id: "candidate", version: 2, status: "published" },
                  { id: "draft", version: 3, status: "draft" },
                ]
              : path.includes("/datasets/dataset/versions")
                ? [{ id: "dataset-version", version: 1, status: "published", caseCount: 3 }]
                : [{ id: "framework-version", version: 1, status: "published" }];
      return Promise.resolve(json(data));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(<ExperimentCreate projectId={project.id} onCreated={onCreated} />);
    await user.type(await screen.findByLabelText("实验名称"), "退款比较");
    await user.selectOptions(screen.getByLabelText("要比较的 Prompt"), "prompt");
    const baseline = screen.getByLabelText<HTMLSelectElement>("基线版本（原来的版本）");
    const candidate = screen.getByLabelText<HTMLSelectElement>("候选版本（想验证的新版本）");
    expect(within(baseline).queryByRole("option", { name: /v3/ })).toBeNull();
    await user.selectOptions(baseline, "baseline");
    expect(within(candidate).getByRole<HTMLOptionElement>("option", { name: /v1/ }).disabled).toBe(
      true,
    );
    await user.selectOptions(candidate, "candidate");
    await user.selectOptions(screen.getByLabelText("评测集版本"), "dataset-version");
    await user.selectOptions(screen.getByLabelText("评判标准版本"), "framework-version");
    await user.click(screen.getByRole("button", { name: "保存实验计划" }));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.[1]?.body as string)).toMatchObject({
      datasetVersionId: "dataset-version",
      frameworkVersionId: "framework-version",
      promptVersions: [
        { promptVersionId: "baseline", isBaseline: true },
        { promptVersionId: "candidate", isBaseline: false },
      ],
    });
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("完成实验可查看诊断，段落重跑必须单独确认费用", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let data: unknown;
      if (path.endsWith("/experiments")) data = [{ ...detail.experiment, status: "succeeded" }];
      else if (path.endsWith("/diagnoses")) data = diagnosisReportFixture;
      else if (path.endsWith("/ablations"))
        data = init?.method === "POST" ? { id: "ablation" } : [];
      else if (path.endsWith("/comparison"))
        data = {
          ...detail.experiment,
          experimentId: "experiment",
          baselinePromptVersionId: "prompt-v1",
          expectedObservationsPerVersion: 1,
          isComplete: true,
          versions: [],
        };
      else
        data = {
          ...detail,
          experiment: { ...detail.experiment, status: "succeeded" },
          promptVersions: [
            { promptVersionId: "prompt-v1", isBaseline: true, label: "基线" },
            { promptVersionId: "prompt-v2", isBaseline: false, label: "候选" },
          ],
        };
      return Promise.resolve(json(data));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentWorkspace project={project} />);
    await screen.findByRole("option", { name: "实验 · 已完成" });
    await user.selectOptions(screen.getByLabelText("历史实验"), "experiment");
    await user.selectOptions(await screen.findByLabelText("要诊断的候选版本"), "prompt-v2");
    await user.click(screen.getByRole("button", { name: "生成 / 更新诊断报告" }));
    await user.selectOptions(await screen.findByLabelText("回退哪个段落？"), "refund_policy");
    const replay = screen.getByRole<HTMLButtonElement>("button", { name: "启动段落验证" });
    expect(replay.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /确认创建真实验证实验/ }));
    await user.click(replay);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]?.[1]?.body as string)).toEqual({
      candidatePromptVersionId: "prompt-v2",
      repetition: 1,
      includeAblations: false,
    });
    expect(JSON.parse(posts[1]?.[1]?.body as string)).toEqual({
      candidatePromptVersionId: "prompt-v2",
      blockId: "refund_policy",
    });
  });

  it("中文项目名称无需填写英文标识", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(input: CreateProject) => Promise<void>>().mockResolvedValue(undefined);
    render(<CreateProjectForm onSubmit={onSubmit} onCancel={() => {}} />);
    await user.type(screen.getByLabelText("项目名称"), "客服项目");
    await user.click(screen.getByRole("button", { name: "创建项目" }));
    expect(onSubmit.mock.calls[0]?.[0].name).toBe("客服项目");
    expect(onSubmit.mock.calls[0]?.[0].slug).toMatch(/^project-/);
  });

  it("手动用例只保存草稿，保留输入并交给人工审核", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ id: "draft", status: "draft" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<ManualDatasetCases datasetId="dataset" onSaved={onSaved} />);
    await user.click(screen.getByText("手动添加用例（无需准备文件）"));
    await user.type(screen.getByLabelText("对话输入"), "如何退款？");
    await user.type(screen.getByLabelText("期望回答或判定依据（可选）"), "先确认订单状态");
    await user.click(screen.getByRole("button", { name: "保存手动用例草稿" }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/datasets/dataset/versions");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"source":"manual"');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"expectedOutput":"先确认订单状态"');
    expect(onSaved).toHaveBeenCalledWith({ id: "draft", status: "draft" });
    expect(screen.getByLabelText<HTMLTextAreaElement>("对话输入").value).toBe("");
  });

  it("手动录入失败保留内容，空白内容不发出请求", async () => {
    const user = userEvent.setup();
    const save = vi
      .spyOn(api, "createDatasetVersion")
      .mockRejectedValue(new Error("服务暂时不可用"));
    render(<ManualDatasetCases datasetId="dataset" onSaved={() => {}} />);
    await user.click(screen.getByText("手动添加用例（无需准备文件）"));
    await user.type(screen.getByLabelText("对话输入"), "   ");
    await user.click(screen.getByRole("button", { name: "保存手动用例草稿" }));
    expect(save).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("对话输入"), "保留这个问题");
    await user.click(screen.getByRole("button", { name: "保存手动用例草稿" }));
    expect(screen.getByRole("alert").textContent).toContain("服务暂时不可用");
    expect(screen.getByLabelText<HTMLTextAreaElement>("对话输入").value).toContain("保留这个问题");
  });

  it("创建模型连接失败也清空密钥，不写入本地存储", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listModelConnections").mockResolvedValue([]);
    const save = vi.spyOn(api, "createModelConnection").mockRejectedValue(new Error("保存失败"));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<ModelWorkspace project={project} />);
    await user.type(await screen.findByLabelText("连接名称"), "测试连接");
    await user.type(screen.getByLabelText(/服务地址/), "https://example.com/v1");
    await user.type(screen.getByLabelText(/API Key/), "test-secret-only");
    await user.type(screen.getByLabelText("可用模型名称"), "model-a,model-a,model-b");
    await user.click(screen.getByRole("button", { name: "保存连接" }));
    expect(save).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        allowedModels: ["model-a", "model-b"],
        apiKey: "test-secret-only",
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/API Key/).value).toBe("");
    expect(storage).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("保存失败");
  });

  it("标准权重校验，保存新版本而不修改已发布版本", async () => {
    const user = userEvent.setup();
    const source: FrameworkVersion = {
      id: "published",
      frameworkId: "framework",
      version: 1,
      status: "published",
      contentHash: "hash",
      parentVersionId: null,
      changeSummary: null,
      createdAt: now,
      publishedAt: now,
      definition: {
        levels: [{ id: "general", name: "通用", description: "通用评测" }],
        dimensions: [
          {
            id: "accuracy",
            name: "准确性",
            description: "事实准确",
            weight: 1,
            scoringGuide: [
              { score: 0, description: "错误" },
              { score: 5, description: "准确" },
            ],
          },
        ],
      },
    };
    const original = JSON.stringify(source);
    const save = vi
      .spyOn(api, "createFrameworkVersion")
      .mockResolvedValue({ ...source, id: "new-draft", status: "draft" });
    const publish = vi.spyOn(api, "publishFrameworkVersion");
    render(<FrameworkEditor frameworkId="framework" source={source} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("权重（%）"), { target: { value: "50" } });
    await user.click(screen.getByRole("button", { name: "保存为新草稿" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("100%");
    fireEvent.change(screen.getByLabelText("权重（%）"), { target: { value: "100" } });
    await user.type(screen.getByLabelText("维度名称"), "新版");
    await user.click(screen.getByRole("button", { name: "保存为新草稿" }));
    expect(save).toHaveBeenCalledWith(
      "framework",
      expect.objectContaining({ parentVersionId: "published" }),
    );
    expect(JSON.stringify(source)).toBe(original);
    expect(publish).not.toHaveBeenCalled();
  });

  it("启动必须确认费用，生成和评分可使用不同连接；预算单价完整传递", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listModelConnections").mockResolvedValue([
      connection,
      { ...connection, id: "judge", name: "评分服务", allowedModels: ["judge-a"] },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);
    const onStarted = vi.fn();
    render(<ExperimentStart detail={detail} onStarted={onStarted} />);
    const generation = within(await screen.findByRole("group", { name: "生成回答的模型" }));
    const judge = within(screen.getByRole("group", { name: "负责评分的模型" }));
    await user.selectOptions(generation.getByLabelText("模型连接"), "generator");
    await user.selectOptions(generation.getByLabelText("模型"), "model-a");
    await user.selectOptions(judge.getByLabelText("模型连接"), "judge");
    await user.selectOptions(judge.getByLabelText("模型"), "judge-a");
    const start = screen.getByRole("button", { name: "确认并开始评测" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/预估费用上限/), "2");
    for (const label of [
      "生成模型输入单价",
      "生成模型输出单价",
      "评分模型输入单价",
      "评分模型输出单价",
    ])
      await user.type(screen.getByLabelText(label), "1");
    await user.click(screen.getByRole("checkbox"));
    await user.click(start);
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      model: "model-a",
      evaluatorModel: "judge-a",
      modelConnectionId: "generator",
      evaluatorConnectionId: "judge",
      costBudget: {
        maxUsd: 2,
        generationInputUsdPerMillionTokens: 1,
        generationOutputUsdPerMillionTokens: 1,
        evaluatorInputUsdPerMillionTokens: 1,
        evaluatorOutputUsdPerMillionTokens: 1,
      },
    });
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it("清除凭证时中止旧项目请求，迟到的响应不能关闭凭证页面", async () => {
    let resolve!: (projects: Project[]) => void;
    const list = vi.spyOn(api, "listProjects").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<App />);
    await userEvent.setup().click(screen.getByRole("button", { name: "设置 / 清除访问凭证" }));
    expect(list.mock.calls[0]?.[0]?.aborted).toBe(true);
    resolve([project]);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "连接受保护的评测服务" })).toBeTruthy(),
    );
    expect(screen.queryByText("当前项目：测试项目")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "连接服务" }).disabled).toBe(
      false,
    );
  });
});
