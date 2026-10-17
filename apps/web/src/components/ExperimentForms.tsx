import { useCallback, useState, type FormEvent } from "react";
import type { Experiment, ExperimentDetail, StartExperiment } from "@ai-chat-eval/contracts";
import { api, getErrorMessage } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";
import { ModelPicker, useModelConnections, type ModelChoice } from "./ModelPicker";
import { useProjectAccess } from "./ProjectAccess";

export function ExperimentCreate({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (experiment: Experiment) => void;
}) {
  const { canEdit } = useProjectAccess();
  const resource = useResource(
    useCallback(
      async (signal: AbortSignal) => {
        const [prompts, datasets, frameworks] = await Promise.all([
          api.listPrompts(projectId, signal),
          api.listDatasets(projectId, signal),
          api.listFrameworks(projectId, signal),
        ]);
        const [promptGroups, datasetGroups, frameworkGroups] = await Promise.all([
          Promise.all(
            prompts.map(async (prompt) => ({
              prompt,
              versions: (await api.listPromptVersions(prompt.id, signal)).filter(
                (v) => v.status === "published",
              ),
            })),
          ),
          Promise.all(
            datasets.map(async (dataset) =>
              (await api.listDatasetVersions(dataset.id, signal))
                .filter((v) => v.status === "published")
                .map((version) => ({ ...version, name: dataset.name })),
            ),
          ),
          Promise.all(
            frameworks.map(async (framework) =>
              (await api.listFrameworkVersions(framework.id, signal))
                .filter((v) => v.status === "published")
                .map((version) => ({ ...version, name: framework.name })),
            ),
          ),
        ]);
        return {
          prompts: promptGroups.filter((item) => item.versions.length >= 2),
          datasets: datasetGroups.flat(),
          frameworks: frameworkGroups.flat(),
        };
      },
      [projectId],
    ),
  );
  const [name, setName] = useState("");
  const [promptId, setPromptId] = useState("");
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [frameworkId, setFrameworkId] = useState("");
  const [repetitions, setRepetitions] = useState(1);
  const [seed, setSeed] = useState(42);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versions = resource.data?.prompts.find((p) => p.prompt.id === promptId)?.versions ?? [];
  const executions =
    (resource.data?.datasets.find((d) => d.id === datasetId)?.caseCount ?? 0) * repetitions * 2;
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit) return;
    setError(null);
    if (
      !baseline ||
      !candidate ||
      baseline === candidate ||
      !versions.some((v) => v.id === baseline) ||
      !versions.some((v) => v.id === candidate)
    ) {
      setError("请选择同一 Prompt 下两个不同的已发布版本。");
      return;
    }
    if (executions < 1 || executions > 5000) {
      setError("本次实验需要在 1～5000 次用例执行以内，请减少用例数或重复次数。");
      return;
    }
    setBusy(true);
    try {
      onCreated(
        await api.createExperiment(projectId, {
          name: name.trim(),
          datasetVersionId: datasetId,
          frameworkVersionId: frameworkId,
          randomSeed: seed,
          repetitions,
          promptVersions: [
            { promptVersionId: baseline, label: "基线版本", isBaseline: true },
            { promptVersionId: candidate, label: "候选版本", isBaseline: false },
          ],
        }),
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flow-card flow-stack">
      <h2>创建版本对比实验</h2>
      <p>两版 Prompt 使用相同的评测集和评判标准。先保存计划，下一步选择模型并确认启动。</p>
      {resource.loading && <LoadingState />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && (
        <form className="flow-form" onSubmit={(e) => void create(e)}>
          <fieldset className="flow-form" disabled={busy || !canEdit}>
            <label>
              实验名称
              <input
                required
                minLength={2}
                maxLength={240}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：退款助手第二版对比"
              />
            </label>
            <label>
              要比较的 Prompt
              <select
                required
                value={promptId}
                onChange={(e) => {
                  setPromptId(e.target.value);
                  setBaseline("");
                  setCandidate("");
                }}
              >
                <option value="">请选择 Prompt</option>
                {resource.data.prompts.map((item) => (
                  <option value={item.prompt.id} key={item.prompt.id}>
                    {item.prompt.name}
                  </option>
                ))}
              </select>
            </label>
            {!resource.data.prompts.length && (
              <p role="status">请先到“Prompt 版本”创建并发布同一 Prompt 的至少两个版本。</p>
            )}
            <div className="flow-row">
              <label>
                基线版本（原来的版本）
                <select required value={baseline} onChange={(e) => setBaseline(e.target.value)}>
                  <option value="">请选择版本</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id} disabled={v.id === candidate}>
                      v{v.version} · {v.changeSummary || "未填写说明"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                候选版本（想验证的新版本）
                <select required value={candidate} onChange={(e) => setCandidate(e.target.value)}>
                  <option value="">请选择版本</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id} disabled={v.id === baseline}>
                      v{v.version} · {v.changeSummary || "未填写说明"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              评测集版本
              <select required value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                <option value="">请选择已发布评测集</option>
                {resource.data.datasets.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · v{v.version} · {v.caseCount} 条用例
                  </option>
                ))}
              </select>
            </label>
            {!resource.data.datasets.length && (
              <p role="status">请先在“评测集”中准备、审核并发布一版用例。</p>
            )}
            <label>
              评判标准版本
              <select required value={frameworkId} onChange={(e) => setFrameworkId(e.target.value)}>
                <option value="">请选择已发布标准</option>
                {resource.data.frameworks.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · v{v.version}
                  </option>
                ))}
              </select>
            </label>
            {!resource.data.frameworks.length && (
              <p role="status">请先在“评判标准”中配置并发布评分规则。</p>
            )}
            <details>
              <summary>重复评测设置</summary>
              <div className="flow-form">
                <label>
                  重复次数
                  <input
                    type="number"
                    required
                    min={1}
                    max={50}
                    step={1}
                    value={repetitions}
                    onChange={(e) => setRepetitions(Number(e.target.value))}
                  />
                </label>
                <label>
                  随机种子（相同数字帮助复现，供应商仍可能有波动）
                  <input
                    type="number"
                    required
                    min={-2147483648}
                    max={2147483647}
                    step={1}
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                  />
                </label>
              </div>
            </details>
            <p role="status">
              计划执行 {executions} 次用例，每次包含生成回答和评分两个阶段；重试可能增加调用。
            </p>
            <button
              className="button button--primary"
              disabled={executions < 1 || executions > 5000}
            >
              保存实验计划
            </button>
          </fieldset>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

export function ExperimentStart({
  detail,
  onStarted,
}: {
  detail: ExperimentDetail;
  onStarted: () => void;
}) {
  const { canEdit } = useProjectAccess();
  const connections = useModelConnections(detail.experiment.projectId);
  const [generation, setGeneration] = useState<ModelChoice>({ connectionId: "", model: "" });
  const [judge, setJudge] = useState<ModelChoice>({ connectionId: "", model: "" });
  const [budget, setBudget] = useState("");
  const [prices, setPrices] = useState(["", "", "", ""]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxTokens, setMaxTokens] = useState(1024);
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || busy || !confirmed || !connections.data) return;
    setBusy(true);
    setError(null);
    try {
      const input: StartExperiment = {
        provider: "openai-compatible",
        model: generation.model.trim(),
        evaluatorModel: judge.model.trim(),
        modelConfig: { temperature: 0, maxTokens },
        ...(connections.data.legacy
          ? {}
          : {
              modelConnectionId: generation.connectionId,
              evaluatorConnectionId: judge.connectionId,
            }),
        ...(budget
          ? {
              costBudget: {
                maxUsd: Number(budget),
                generationInputUsdPerMillionTokens: Number(prices[0]),
                generationOutputUsdPerMillionTokens: Number(prices[1]),
                evaluatorInputUsdPerMillionTokens: Number(prices[2]),
                evaluatorOutputUsdPerMillionTokens: Number(prices[3]),
              },
            }
          : {}),
      };
      await api.startExperiment(detail.experiment.projectId, detail.experiment.id, input);
      onStarted();
    } catch (caught) {
      setError(getErrorMessage(caught) + " 如连接中断，请刷新实验状态后再重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flow-card flow-form" onSubmit={(e) => void start(e)}>
      <h2>选择模型并确认启动</h2>
      {connections.loading && <LoadingState />}
      {connections.error && <ErrorState message={connections.error} onRetry={connections.reload} />}
      {connections.data && (
        <fieldset className="flow-form" disabled={busy || !canEdit}>
          <ModelPicker
            label="生成回答的模型"
            {...connections.data}
            value={generation}
            onChange={setGeneration}
          />
          <ModelPicker
            label="负责评分的模型"
            {...connections.data}
            value={judge}
            onChange={setJudge}
          />
          <label>
            每条回答最多生成的长度（Token，约为文字片段数）
            <input
              type="number"
              required
              min={1}
              max={8192}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
            />
          </label>
          <label>
            预估费用上限（美元，可选）
            <input
              type="number"
              min={0.01}
              max={100000}
              step={0.01}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="不填写则不设平台预估费用上限"
            />
          </label>
          {budget && (
            <>
              <p>
                按供应商当前价格填写；价格单位是每百万 Token
                的美元价格。平台据此预留预算，不等于最终账单。
              </p>
              <div className="flow-row">
                {[
                  "生成模型输入单价",
                  "生成模型输出单价",
                  "评分模型输入单价",
                  "评分模型输出单价",
                ].map((label, index) => (
                  <label key={label}>
                    {label}
                    <input
                      type="number"
                      required
                      min={0.000001}
                      max={1000}
                      step="any"
                      value={prices[index]}
                      onChange={(e) =>
                        setPrices((current) =>
                          current.map((value, i) => (i === index ? e.target.value : value)),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            </>
          )}
          <p>
            本次计划：{detail.progress.plannedCaseExecutions}{" "}
            次用例执行。输入内容会发送给所选模型供应商。
          </p>
          <label className="flow-check">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已确认模型和用例数量，理解启动会产生模型调用费用。
          </label>
          <button
            className="button button--primary"
            disabled={!confirmed || !generation.model || !judge.model}
          >
            {busy ? "正在提交…" : "确认并开始评测"}
          </button>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
