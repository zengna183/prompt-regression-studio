import { useCallback, useEffect, useState } from "react";
import type {
  Project,
  ExperimentDetail,
  ExperimentComparison,
  Ablation,
} from "@ai-chat-eval/contracts";
import { api, getErrorMessage, getDiagnosisErrorMessage } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";
import { ExperimentCreate, ExperimentStart } from "./ExperimentForms";
import { DiagnosisReportView } from "./DiagnosisReport";
import type { DiagnosisReport } from "../diagnosis/types";
import { useProjectAccess } from "./ProjectAccess";

export const runStatusLabels: Record<string, string> = {
  draft: "草稿",
  queued: "等待执行",
  running: "正在评测",
  succeeded: "已完成",
  partially_succeeded: "部分完成",
  failed: "执行失败",
  cancelled: "已取消",
};
const percent = (value: number | null) =>
  value === null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;

export function ExperimentWorkspace({ project }: { project: Project }) {
  const { canEdit } = useProjectAccess();
  const list = useResource(
    useCallback((signal: AbortSignal) => api.listExperiments(project.id, signal), [project.id]),
  );
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  function open(id: string) {
    setSelectedId(id);
    setCreating(false);
  }
  return (
    <main className="workspace flow-workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb">{project.name} / 实验与结果</div>
          <h1>比较 Prompt，找到改进依据</h1>
          <p>先比较效果，再查看退化原因；段落验证会真实重跑模型，不把猜测当作原因。</p>
        </div>
        <button
          className="button button--primary"
          disabled={!canEdit}
          onClick={() => setCreating(true)}
        >
          新建实验
        </button>
      </header>
      {list.loading && <LoadingState />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      <div className="flow-actions">
        <label>
          历史实验
          <select value={selectedId} onChange={(e) => open(e.target.value)}>
            <option value="">请选择实验</option>
            {list.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {runStatusLabels[item.status]}
              </option>
            ))}
          </select>
        </label>
        <button className="button button--quiet" onClick={list.reload}>
          刷新列表
        </button>
      </div>
      {canEdit && (creating || (!selectedId && list.data?.length === 0)) && (
        <ExperimentCreate
          projectId={project.id}
          onCreated={(experiment) => {
            open(experiment.id);
            list.reload();
          }}
        />
      )}
      {!creating && selectedId && (
        <ExperimentView
          key={selectedId}
          projectId={project.id}
          experimentId={selectedId}
          onOpen={(id) => {
            open(id);
            list.reload();
          }}
        />
      )}
      {!creating && !selectedId && Boolean(list.data?.length) && (
        <p>选择历史实验查看进度和结果，或点击“新建实验”。</p>
      )}
    </main>
  );
}

function ExperimentView({
  projectId,
  experimentId,
  onOpen,
}: {
  projectId: string;
  experimentId: string;
  onOpen: (id: string) => void;
}) {
  const { canEdit } = useProjectAccess();
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [comparison, setComparison] = useState<ExperimentComparison | null>(null);
  const [ablations, setAblations] = useState<Ablation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [candidateId, setCandidateId] = useState("");
  const [report, setReport] = useState<DiagnosisReport | null>(null);
  const [blockId, setBlockId] = useState("");
  const [replayConfirmed, setReplayConfirmed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = await api.getExperiment(projectId, experimentId, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next);
        setError(null);
        const [scores, links] = await Promise.all([
          api.compareExperiment(projectId, experimentId, controller.signal),
          api.listAblations(projectId, experimentId, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setComparison(scores);
        setAblations(links);
        if (["queued", "running"].includes(next.experiment.status))
          timer = setTimeout(() => void load(), 5000);
      } catch (caught) {
        if (!controller.signal.aborted)
          setError(getErrorMessage(caught) + " 自动刷新已暂停，请点击刷新状态重试。");
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, experimentId, revision]);
  function refresh() {
    setRevision((value) => value + 1);
  }
  async function cancel() {
    if (!canEdit || busy || !cancelConfirmed) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelExperiment(projectId, experimentId);
      refresh();
    } catch (caught) {
      setActionError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function diagnose() {
    if (!canEdit || !candidateId || busy) return;
    setBusy(true);
    setActionError(null);
    setReport(null);
    setBlockId("");
    setReplayConfirmed(false);
    try {
      setReport(await api.diagnoseExperiment(projectId, experimentId, candidateId));
    } catch (caught) {
      setActionError(getDiagnosisErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function replay() {
    if (!canEdit || !report || !blockId || !replayConfirmed || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.createAblation(
        projectId,
        experimentId,
        report.candidate_prompt_version_id,
        blockId,
      );
      setReplayConfirmed(false);
      refresh();
    } catch (caught) {
      setActionError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return error ? (
      <ErrorState message={error} onRetry={refresh} />
    ) : (
      <LoadingState label="正在读取实验" />
    );
  const active = ["queued", "running"].includes(detail.experiment.status);
  return (
    <section className="flow-stack">
      <div className="flow-card flow-stack">
        <div className="flow-actions">
          <h2>{detail.experiment.name}</h2>
          <span className="flow-badge" role="status">
            {runStatusLabels[detail.experiment.status]}
          </span>
          <button className="button button--quiet" onClick={refresh} disabled={busy}>
            刷新状态
          </button>
        </div>
        <p>
          {detail.progress.completedRuns} / {detail.progress.plannedRuns} 个执行任务已结束；
          {detail.progress.completedCaseExecutions} / {detail.progress.plannedCaseExecutions}{" "}
          次用例已有结果。
        </p>
        <progress max={1} value={detail.progress.completionRate} aria-label="实验完成进度" />
        {active && <p>每 5 秒更新一次。关闭页面不会取消实验。</p>}
        {detail.costBudget && (
          <p>
            已预留费用 ${detail.costBudget.reservedUsd.toFixed(4)} / 预估上限 $
            {detail.costBudget.maxUsd.toFixed(2)}，不是供应商最终账单。
          </p>
        )}
        {detail.failureMessage && (
          <p role="alert">
            {detail.failureMessage}（{detail.failureCode}）
          </p>
        )}
        {active && (
          <details>
            <summary>取消本次实验</summary>
            <p>将停止后续调用，已经发出的请求可能仍产生费用。</p>
            <label className="flow-check">
              <input
                type="checkbox"
                checked={cancelConfirmed}
                onChange={(e) => setCancelConfirmed(e.target.checked)}
              />
              确认停止这次实验
            </label>
            <button
              className="button button--secondary"
              disabled={!canEdit || !cancelConfirmed || busy}
              onClick={() => void cancel()}
            >
              确认取消
            </button>
          </details>
        )}
      </div>
      {error && <ErrorState message={error} onRetry={refresh} />}
      {actionError && (
        <p role="alert" className="form-error">
          {actionError}
        </p>
      )}
      {detail.experiment.status === "draft" && canEdit && (
        <ExperimentStart detail={detail} onStarted={refresh} />
      )}
      {detail.runs.length > 0 && (
        <details className="flow-card">
          <summary>查看每个任务的状态和失败原因</summary>
          <ul>
            {detail.runs.map((run) => (
              <li key={run.evaluationRunId}>
                {run.label} · 第 {run.repetition} 次 · {runStatusLabels[run.status]} · 成功{" "}
                {run.succeededCount} / 失败 {run.failedCount}
                {run.failureMessage && (
                  <p>
                    {run.failureMessage}（{run.failureCode}）
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {comparison && detail.experiment.status !== "draft" && (
        <ComparisonView comparison={comparison} />
      )}
      {detail.experiment.status === "succeeded" && (
        <section className="flow-card flow-form">
          <h2>查看为什么变好或变差</h2>
          <p>
            诊断使用第 1
            次重复评测的数据。段落归因先给出待验证解释，只有重跑证据达到条件才支持该解释。
          </p>
          <label>
            要诊断的候选版本
            <select
              value={candidateId}
              disabled={busy}
              onChange={(e) => {
                setCandidateId(e.target.value);
                setReport(null);
                setReplayConfirmed(false);
              }}
            >
              <option value="">请选择候选版本</option>
              {detail.promptVersions
                .filter((item) => !item.isBaseline)
                .map((item) => (
                  <option key={item.promptVersionId} value={item.promptVersionId}>
                    {item.label}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="button button--primary"
            disabled={!canEdit || !candidateId || busy}
            onClick={() => void diagnose()}
          >
            {busy ? "正在处理…" : "生成 / 更新诊断报告"}
          </button>
          {report && (
            <>
              <DiagnosisReportView report={report} />
              {report.prompt_changes.length > 0 && (
                <div className="flow-form">
                  <h3>用真实重跑验证某个段落</h3>
                  <p>
                    将候选版本中的一个段落回退成基线版本的内容，再与候选版本一起重跑。最多验证 5
                    个段落，沿用原实验的模型和预算配置，会产生新的调用费用。
                  </p>
                  <label>
                    回退哪个段落？
                    <select
                      value={blockId}
                      onChange={(e) => {
                        setBlockId(e.target.value);
                        setReplayConfirmed(false);
                      }}
                      disabled={busy}
                    >
                      <option value="">请选择变化的段落</option>
                      {report.prompt_changes.map((change) => (
                        <option key={change.id} value={change.segment_id}>
                          {change.segment_id} · {change.semantic_summary || change.change_type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flow-check">
                    <input
                      type="checkbox"
                      checked={replayConfirmed}
                      onChange={(e) => setReplayConfirmed(e.target.checked)}
                    />
                    确认创建真实验证实验并承担新的模型调用费用
                  </label>
                  <button
                    className="button button--secondary"
                    disabled={!canEdit || !blockId || !replayConfirmed || busy}
                    onClick={() => void replay()}
                  >
                    启动段落验证
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {ablations.length > 0 && (
        <section className="flow-card">
          <h2>已创建的段落验证</h2>
          <p>打开验证实验查看进度；完成后回到当前实验，点击“生成 / 更新诊断报告”汇总新证据。</p>
          <ul>
            {ablations.map((link) => (
              <li key={link.id}>
                段落 {link.revertedBlockId}{" "}
                <button className="button button--quiet" onClick={() => onOpen(link.experimentId)}>
                  打开验证实验
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

export function ComparisonView({ comparison }: { comparison: ExperimentComparison }) {
  return (
    <section className="flow-card flow-stack">
      <h2>版本效果对比</h2>
      {!comparison.isComplete && (
        <p role="status">结果尚不完整。以下只反映已经成功评分的用例，不据此宣布哪个版本最好。</p>
      )}
      <p>
        分数已统一成百分比；胜 / 平 /
        负只比较两版都完成的同一用例。平均分差异不等于统计上可靠的提升。
      </p>
      <div className="version-table-wrap">
        <table className="version-table">
          <caption>各版本总体表现</caption>
          <thead>
            <tr>
              <th>版本</th>
              <th>平均分</th>
              <th>覆盖率</th>
              <th>通过率</th>
              <th>较基线变化</th>
              <th>成对胜 / 平 / 负</th>
            </tr>
          </thead>
          <tbody>
            {comparison.versions.map((version) => (
              <tr key={version.promptVersionId}>
                <th scope="row">
                  {version.label}
                  {version.isBaseline ? "（基线）" : ""}
                </th>
                <td>{percent(version.averageScore)}</td>
                <td>{percent(version.coverageRate)}</td>
                <td>{percent(version.passRate)}</td>
                <td>
                  {version.deltaFromBaseline === null
                    ? "—"
                    : `${(version.deltaFromBaseline * 100).toFixed(1)} 个百分点`}
                </td>
                <td>
                  {version.pairedComparison
                    ? `${version.pairedComparison.wins} / ${version.pairedComparison.ties} / ${version.pairedComparison.losses}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison.versions.map((version) => (
        <details key={version.promptVersionId}>
          <summary>{version.label}：各维度表现</summary>
          <ul>
            {version.dimensions.map((dimension) => (
              <li key={dimension.metricKey}>
                {dimension.metricKey}：平均分 {percent(dimension.averageScore)}，覆盖率{" "}
                {percent(dimension.coverageRate)}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
