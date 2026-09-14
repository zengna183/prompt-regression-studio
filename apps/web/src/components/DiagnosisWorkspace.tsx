import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { api, getDiagnosisErrorMessage } from "../api/client";
import type {
  CanonicalRegressionBundle,
  DiagnosisReport,
  DiagnosisRunSummary,
} from "../diagnosis/types";
import { MAX_BUNDLE_BYTES, parseCanonicalBundleText } from "../diagnosis/validation";
import { DiagnosisReportView } from "./DiagnosisReport";

type RunState = "idle" | "ready" | "running" | "error" | "complete";

interface SelectedBundle {
  readonly bundle: CanonicalRegressionBundle;
  readonly sourceName: string;
  readonly size: number;
}

export function DiagnosisWorkspace() {
  const [selected, setSelected] = useState<SelectedBundle | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [report, setReport] = useState<DiagnosisReport | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [history, setHistory] = useState<readonly DiagnosisRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openingRunId, setOpeningRunId] = useState<string | null>(null);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => {
      controller.abort();
      requestController.current?.abort();
    };
  }, []);

  async function loadHistory(signal?: AbortSignal): Promise<void> {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await api.listDiagnoses(signal));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHistoryError(getDiagnosisErrorMessage(error));
    } finally {
      if (!signal?.aborted) setHistoryLoading(false);
    }
  }

  async function selectFile(file: File): Promise<void> {
    setInputError(null);
    if (file.size > MAX_BUNDLE_BYTES) {
      rejectInput("文件大小为 " + formatFileSize(file.size) + "，超过网页端 8 MB 限制。");
      return;
    }
    try {
      const text = await file.text();
      acceptText(text, file.name, file.size);
    } catch {
      rejectInput("无法读取这个文件，请确认文件仍然可用后重试。");
    }
  }

  function acceptText(text: string, sourceName: string, knownSize?: number): void {
    const result = parseCanonicalBundleText(text);
    if (!result.ok) {
      rejectInput(result.message);
      return;
    }
    requestController.current?.abort();
    setSelected({
      bundle: result.bundle,
      sourceName,
      size: knownSize ?? new TextEncoder().encode(text).byteLength,
    });
    setInputError(null);
    setRunError(null);
    setReport(null);
    setRunState("ready");
  }

  function rejectInput(message: string): void {
    setSelected(null);
    setReport(null);
    setRunError(null);
    setInputError(message);
    setRunState("idle");
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void selectFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragActive(false);
    const files = event.dataTransfer.files;
    if (files.length !== 1) {
      rejectInput("请一次只拖入一个 canonical bundle JSON 文件。");
      return;
    }
    const file = files.item(0);
    if (file) void selectFile(file);
  }

  async function runDiagnosis(): Promise<void> {
    if (!selected || runState === "running") return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setRunState("running");
    setRunError(null);
    try {
      const nextReport = await api.diagnose(selected.bundle, controller.signal);
      if (controller.signal.aborted) return;
      setReport(nextReport);
      setRunState("complete");
      void loadHistory();
    } catch (error) {
      if (controller.signal.aborted) return;
      setRunError(getDiagnosisErrorMessage(error));
      setRunState("error");
    } finally {
      if (requestController.current === controller) requestController.current = null;
    }
  }

  function cancelDiagnosis(): void {
    requestController.current?.abort();
    requestController.current = null;
    setRunError(null);
    setRunState("ready");
  }

  function resetSelection(): void {
    requestController.current?.abort();
    requestController.current = null;
    setSelected(null);
    setReport(null);
    setInputError(null);
    setRunError(null);
    setPasteText("");
    setRunState("idle");
  }

  async function openHistoryRun(id: string): Promise<void> {
    if (runState === "running" || openingRunId) return;
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    setOpeningRunId(id);
    setHistoryError(null);
    try {
      const run = await api.getDiagnosis(id, controller.signal);
      if (controller.signal.aborted) return;
      if (!run.report) {
        setHistoryError(run.failureMessage || "这次诊断没有生成可查看的报告。");
        return;
      }
      setReport(run.report);
      setRunState("complete");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setHistoryError(getDiagnosisErrorMessage(error));
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setOpeningRunId(null);
    }
  }

  return (
    <main className="diagnosis-workspace">
      <header className="diagnosis-hero">
        <div>
          <div className="breadcrumb">
            <span>工作台</span>
            <span aria-hidden="true">/</span>
            <strong>Prompt 回归诊断</strong>
          </div>
          <span className="eyebrow">CONTROLLED DIAGNOSIS</span>
          <h1>找出新 Prompt 为什么变差</h1>
          <p>
            上传同一批用例上的基线与候选评测包。平台会检测回归、比较 Prompt
            区段、提出假设，并只依据受控消融证据支持或否定根因。
          </p>
        </div>
        <div className="diagnosis-principle">
          <span aria-hidden="true">01</span>
          <strong>先比较，再归因</strong>
          <small>不重新生成历史结果，不让 AI 凭感觉宣布根因</small>
        </div>
      </header>

      <div className="diagnosis-content">
        <section className="bundle-panel" aria-labelledby="bundle-panel-title">
          <header className="bundle-panel__header">
            <div>
              <span className="eyebrow">INPUT</span>
              <h2 id="bundle-panel-title">选择评测包</h2>
              <p>
                使用 <code>prompt-regression.bundle/v1alpha1</code> canonical bundle JSON。
                网页先做基础检查，服务端随后执行完整且严格的校验。
              </p>
            </div>
            {selected ? (
              <button className="button button--quiet" type="button" onClick={resetSelection}>
                更换文件
              </button>
            ) : null}
          </header>

          <div
            className={"bundle-drop-zone" + (dragActive ? " bundle-drop-zone--active" : "")}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragActive(false);
            }}
            onDrop={handleDrop}
          >
            <span className="bundle-drop-zone__mark" aria-hidden="true">
              JSON
            </span>
            <div>
              <strong>拖入 canonical bundle</strong>
              <p>或使用下面的文件选择器；最大 8 MB</p>
            </div>
            <label className="bundle-file-label" htmlFor="diagnosis-bundle-file">
              评测包文件
              <input
                id="diagnosis-bundle-file"
                className="bundle-file-input"
                type="file"
                accept="application/json,.json"
                onChange={handleFileChange}
              />
            </label>
          </div>

          {inputError ? (
            <div className="bundle-message bundle-message--error" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <strong>无法使用这个评测包</strong>
                <p>{inputError}</p>
              </div>
            </div>
          ) : null}

          {selected ? (
            <div className="bundle-message bundle-message--ready" role="status">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>评测包已就绪</strong>
                <p>
                  {selected.sourceName} · {formatFileSize(selected.size)} · ID：
                  <code>{selected.bundle.bundle_id}</code>
                </p>
              </div>
            </div>
          ) : null}

          <details className="paste-option">
            <summary>高级方式：直接粘贴 JSON</summary>
            <div>
              <label htmlFor="diagnosis-bundle-text">
                Canonical bundle JSON
                <textarea
                  id="diagnosis-bundle-text"
                  value={pasteText}
                  rows={8}
                  spellCheck={false}
                  placeholder="在这里粘贴完整 JSON；大型评测包建议使用文件方式。"
                  onChange={(event) => setPasteText(event.target.value)}
                  aria-describedby="diagnosis-paste-help"
                />
              </label>
              <p id="diagnosis-paste-help">
                这里只用于小型调试数据，避免在浏览器表单中处理巨型 JSON。
              </p>
              <button
                className="button button--secondary"
                type="button"
                disabled={!pasteText.trim()}
                onClick={() => acceptText(pasteText, "粘贴的 JSON")}
              >
                使用粘贴内容
              </button>
            </div>
          </details>

          <div className="diagnosis-run-bar" aria-live="polite" aria-busy={runState === "running"}>
            <div>
              <strong>
                {runState === "running"
                  ? "正在运行诊断"
                  : runState === "complete"
                    ? "诊断已完成"
                    : "准备运行"}
              </strong>
              <p>
                {runState === "running"
                  ? "正在检测回归、聚类失败并核对消融证据，请勿关闭页面。"
                  : "诊断不会修改原始 Prompt 或历史评测结果。"}
              </p>
            </div>
            {runState === "running" ? (
              <div className="run-actions">
                <span className="spinner" aria-hidden="true" />
                <button className="button button--quiet" type="button" onClick={cancelDiagnosis}>
                  取消
                </button>
              </div>
            ) : (
              <button
                className="button button--primary"
                type="button"
                disabled={!selected}
                onClick={() => void runDiagnosis()}
              >
                {report ? "重新运行诊断" : "开始诊断"}
              </button>
            )}
          </div>

          {runState === "error" && runError ? (
            <div className="bundle-message bundle-message--error" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <strong>诊断没有完成</strong>
                <p>{runError}</p>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => void runDiagnosis()}
                >
                  重试诊断
                </button>
              </div>
            </div>
          ) : null}

          <DiagnosisHistory
            runs={history}
            loading={historyLoading}
            error={historyError}
            openingRunId={openingRunId}
            disabled={runState === "running"}
            onRefresh={() => void loadHistory()}
            onOpen={(id) => void openHistoryRun(id)}
          />
        </section>

        {report ? <DiagnosisReportView report={report} /> : <DiagnosisGuide />}
      </div>
    </main>
  );
}

function DiagnosisHistory({
  runs,
  loading,
  error,
  openingRunId,
  disabled,
  onRefresh,
  onOpen,
}: {
  runs: readonly DiagnosisRunSummary[];
  loading: boolean;
  error: string | null;
  openingRunId: string | null;
  disabled: boolean;
  onRefresh: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="diagnosis-history" aria-labelledby="diagnosis-history-title">
      <header>
        <div>
          <span className="eyebrow">HISTORY</span>
          <h3 id="diagnosis-history-title">最近诊断</h3>
        </div>
        <button
          className="button button--quiet"
          type="button"
          disabled={loading}
          onClick={onRefresh}
        >
          刷新
        </button>
      </header>
      {loading ? <p className="diagnosis-history__status">正在读取已保存记录…</p> : null}
      {!loading && error ? (
        <div className="diagnosis-history__error" role="status">
          <p>{error}</p>
          <small>诊断功能仍可使用；请确认数据库迁移完成后再刷新历史。</small>
        </div>
      ) : null}
      {!loading && !error && runs.length === 0 ? (
        <p className="diagnosis-history__status">还没有已保存的诊断记录。</p>
      ) : null}
      {!loading && !error && runs.length > 0 ? (
        <ol className="diagnosis-history__list">
          {runs.map((run) => {
            const canOpen = run.status === "succeeded";
            return (
              <li key={run.id}>
                <button
                  type="button"
                  disabled={disabled || !canOpen || openingRunId !== null}
                  onClick={() => onOpen(run.id)}
                >
                  <span>
                    <strong>{run.bundleId}</strong>
                    <small>{formatHistoryTime(run.createdAt)}</small>
                  </span>
                  <span
                    className={`diagnosis-history__badge diagnosis-history__badge--${run.status}`}
                  >
                    {historyStatusLabel(run.status)}
                  </span>
                  <span aria-hidden="true">{openingRunId === run.id ? "…" : "›"}</span>
                </button>
                {!canOpen && run.failureMessage ? <p>{run.failureMessage}</p> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function DiagnosisGuide() {
  return (
    <section className="diagnosis-guide" aria-labelledby="diagnosis-guide-title">
      <span className="eyebrow">WHAT YOU WILL GET</span>
      <h2 id="diagnosis-guide-title">报告会回答什么</h2>
      <ol>
        <li>
          <span>1</span>
          <div>
            <strong>哪些用例真的退化</strong>
            <p>使用同一用例一一对比基线和候选结果，不把模型错误混成 Prompt 问题。</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>哪一段 Prompt 值得怀疑</strong>
            <p>按稳定区段 ID 显示修改，并与失败组建立可追溯关联。</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>证据是否足以支持根因</strong>
            <p>同时检查目标恢复与最坏对照损伤；没有消融支持的仍然只是候选假设。</p>
          </div>
        </li>
      </ol>
    </section>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return String(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function historyStatusLabel(status: DiagnosisRunSummary["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}
