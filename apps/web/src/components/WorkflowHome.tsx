import { useCallback } from "react";
import type { Project } from "@ai-chat-eval/contracts";
import type { ActiveView } from "../App";
import { api, ApiError } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";

export function WorkflowHome({
  project,
  onNavigate,
}: {
  project: Project;
  onNavigate: (view: ActiveView) => void;
}) {
  const readiness = useResource(
    useCallback(
      async (signal: AbortSignal) => {
        const [prompts, datasets, frameworks, connections, experiments] = await Promise.all([
          api.listPrompts(project.id, signal),
          api.listDatasets(project.id, signal),
          api.listFrameworks(project.id, signal),
          api.listModelConnections(project.id, signal).catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          }),
          api.listExperiments(project.id, signal),
        ]);
        const [promptVersions, datasetVersions, frameworkVersions] = await Promise.all([
          Promise.all(prompts.map((item) => api.listPromptVersions(item.id, signal))),
          Promise.all(datasets.map((item) => api.listDatasetVersions(item.id, signal))),
          Promise.all(frameworks.map((item) => api.listFrameworkVersions(item.id, signal))),
        ]);
        return {
          models: connections === null ? null : connections.some((item) => !item.disabledAt),
          catalog: promptVersions.some(
            (versions) => versions.filter((v) => v.status === "published").length >= 2,
          ),
          datasets: datasetVersions.flat().some((v) => v.status === "published"),
          frameworks: frameworkVersions.flat().some((v) => v.status === "published"),
          experiments: experiments.length > 0,
        };
      },
      [project.id],
    ),
  );
  const steps = [
    {
      view: "models" as const,
      title: "连接模型",
      text: "添加模型服务地址和密钥，测试能否正常回答。",
    },
    {
      view: "catalog" as const,
      title: "准备两个 Prompt 版本",
      text: "保留原版作为基线，发布要验证的新版本。Prompt 就是指导 AI 回答的指令。",
    },
    {
      view: "datasets" as const,
      title: "准备评测集",
      text: "手动录入、导入文件或让 AI 生成用例，人工审核后发布。",
    },
    {
      view: "frameworks" as const,
      title: "确定评判标准",
      text: "用评分维度、权重和分数说明定义什么是好回答。",
    },
    {
      view: "experiments" as const,
      title: "运行实验并查看结果",
      text: "选择相同用例与标准，比较两版表现，再用诊断和段落重跑查找原因。",
    },
  ];
  return (
    <main className="workspace flow-workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb">{project.name} / 开始评测</div>
          <h1>从一个问题，到有依据的改进</h1>
          <p>按下面五步完成一次评测。配置会保存在项目中，下次可以直接复用。</p>
        </div>
      </header>
      {readiness.loading && <LoadingState label="正在检查项目准备情况" />}
      {readiness.error && <ErrorState message={readiness.error} onRetry={readiness.reload} />}
      <ol className="flow-steps">
        {steps.map((step, index) => (
          <li className="flow-card" key={step.view}>
            <span className="flow-step-number">{index + 1}</span>
            <div>
              <h2>{step.title}</h2>
              <p>{step.text}</p>
              <span className="flow-badge">
                {!readiness.data
                  ? "待检查"
                  : readiness.data[step.view] === null
                    ? "服务器默认连接，请在实验中确认"
                    : readiness.data[step.view]
                      ? "已具备"
                      : "待准备"}
              </span>
            </div>
            <button className="button button--secondary" onClick={() => onNavigate(step.view)}>
              前往设置
            </button>
          </li>
        ))}
      </ol>
    </main>
  );
}
