import { useEffect, useId, useRef, useState } from "react";
import type {
  DatasetImportFormat,
  DatasetImportPreview,
  DatasetVersion,
} from "@ai-chat-eval/contracts";

import { api, ApiError, getErrorMessage } from "../api/client";
import { IMPORT_LIMIT_BYTES, importTemplates, summarizeImportValue } from "../lib/datasetImport";

export function DatasetImport({
  datasetId,
  onSaved,
}: {
  datasetId: string;
  onSaved: (version: DatasetVersion) => void;
}) {
  const id = useId();
  const [format, setFormat] = useState<DatasetImportFormat>("json");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<DatasetImportPreview | null>(null);
  const [phase, setPhase] = useState<"idle" | "reading" | "previewing" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<DatasetVersion | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const busy = phase !== "idle";
  useEffect(
    () => () => {
      requestId.current++;
      controller.current?.abort();
    },
    [],
  );

  function change(nextContent: string, nextFormat = format) {
    requestId.current++;
    controller.current?.abort();
    setContent(nextContent);
    setFormat(nextFormat);
    setPreview(null);
    setSaved(null);
    setError(null);
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    change("");
    const current = requestId.current;
    setPhase("reading");
    try {
      if (file.size > IMPORT_LIMIT_BYTES) throw new Error("文件超过 2 MiB，请拆分后导入。");
      const nextFormat = /\.csv$/iu.test(file.name)
        ? "csv"
        : /\.json$/iu.test(file.name)
          ? "json"
          : null;
      if (!nextFormat) throw new Error("请选择 .json 或 .csv 文件。");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error("文件不是有效的 UTF-8 编码，请另存为 UTF-8 后重试。");
      }
      if (current === requestId.current) {
        setContent(text);
        setFormat(nextFormat);
      }
    } catch (caught) {
      if (current === requestId.current) setError(getErrorMessage(caught));
    } finally {
      if (current === requestId.current) setPhase("idle");
    }
  }
  async function runPreview() {
    const current = ++requestId.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setPhase("previewing");
    setPreview(null);
    setError(null);
    setSaved(null);
    try {
      if (new TextEncoder().encode(content).length > IMPORT_LIMIT_BYTES)
        throw new Error("内容超过 2 MiB，请拆分后导入。");
      const result = await api.previewDatasetImport(
        datasetId,
        { format, content },
        controller.current.signal,
      );
      if (current === requestId.current) setPreview(result);
    } catch (caught) {
      if (current === requestId.current) setError(getErrorMessage(caught));
    } finally {
      if (current === requestId.current) setPhase("idle");
    }
  }
  async function save() {
    if (!preview?.canImport || busy || saved) return;
    const current = ++requestId.current;
    controller.current = new AbortController();
    setPhase("saving");
    setError(null);
    try {
      const version = await api.importDataset(
        datasetId,
        { format, content, previewHash: preview.previewHash },
        controller.current.signal,
      );
      if (current === requestId.current) {
        setSaved(version);
        onSaved(version);
      }
    } catch (caught) {
      if (current === requestId.current)
        setError(
          caught instanceof ApiError && caught.code === "DATASET_VERSION_CONTENT_EXISTS"
            ? "相同的用例已保存过，请查看下方版本列表。"
            : getErrorMessage(caught),
        );
    } finally {
      if (current === requestId.current) setPhase("idle");
    }
  }
  return (
    <section className="dataset-import" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>导入对话用例</h2>
      <p>先校验和预览，再保存为待审核草稿。不会自动发布，也不会调用模型。</p>
      <div className="dataset-import__controls">
        <label htmlFor={`${id}-file`}>
          选择文件（UTF-8，最多 2 MiB）
          <input
            id={`${id}-file`}
            type="file"
            accept=".json,.csv"
            disabled={busy}
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <label htmlFor={`${id}-format`}>
          文件格式
          <select
            id={`${id}-format`}
            value={format}
            disabled={busy}
            onChange={(event) => change(content, event.target.value as DatasetImportFormat)}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </label>
      </div>
      <div className="dataset-import__actions">
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={() => change(importTemplates.json, "json")}
        >
          载入 JSON 模板
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={() => change(importTemplates.csv, "csv")}
        >
          载入 CSV 模板
        </button>
      </div>
      <label htmlFor={`${id}-content`}>
        文件内容（也可直接粘贴）
        <textarea
          id={`${id}-content`}
          rows={10}
          value={content}
          maxLength={IMPORT_LIMIT_BYTES}
          disabled={busy}
          onChange={(event) => change(event.target.value)}
          spellCheck={false}
        />
      </label>
      <p className="dataset-import__hint">
        JSON 顶层为用例数组；CSV 用 input 保存普通文字，inputJson 保存结构化
        JSON，两者不能同时使用。caseKey 是唯一编号，可省略后自动生成。CSV
        的“记录序号”包括表头；带换行的单元格仍算一条记录。
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className="button button--secondary"
        disabled={busy || !content.trim()}
        onClick={() => void runPreview()}
      >
        {phase === "previewing" ? "正在校验…" : "校验并预览"}
      </button>
      {phase === "reading" ? <p role="status">正在读取文件…</p> : null}
      {preview ? <DatasetImportPreviewView preview={preview} /> : null}
      {preview ? (
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !preview.canImport || Boolean(saved)}
          onClick={() => void save()}
        >
          {phase === "saving" ? "正在保存…" : "确认保存全部用例为草稿"}
        </button>
      ) : null}
      {saved ? (
        <p role="status">
          已保存草稿 v{saved.version}，共 {saved.caseCount}{" "}
          条。尚未发布，请人工审核后再用于正式评测。
        </p>
      ) : null}
    </section>
  );
}

export function DatasetImportPreviewView({ preview }: { preview: DatasetImportPreview }) {
  return (
    <div className="dataset-import__preview" aria-live="polite">
      <h3>
        预览结果：{preview.totalRows} 条，{preview.validRows} 条通过，{preview.errorCount} 个错误
      </h3>
      {!preview.canImport ? (
        <p className="form-error">存在错误，不能导入；不会只保存通过的部分。</p>
      ) : (
        <p>
          下方仅展示前 {preview.previewRows.length} 条。确认后保存全部 {preview.validRows}{" "}
          条为草稿。
        </p>
      )}
      {preview.issues.length > 0 ? (
        <ul>
          {preview.issues.map((issue, index) => (
            <li key={`${issue.row}-${index}`}>
              {issue.row === 0 ? "文件" : `记录 ${issue.row}`} · {issue.field}：{issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {preview.issuesTruncated ? <p>错误较多，仅展示前 100 个。请修正后重新预览。</p> : null}
      {preview.previewRows.length > 0 ? (
        <div className="version-table-wrap">
          <table className="version-table">
            <thead>
              <tr>
                <th>记录</th>
                <th>编号 / 名称</th>
                <th>输入</th>
                <th>预期输出</th>
              </tr>
            </thead>
            <tbody>
              {preview.previewRows.map((row) => (
                <tr key={row.row}>
                  <td>{row.row}</td>
                  <td>
                    {row.case.caseKey}
                    <br />
                    {row.case.name}
                  </td>
                  <td>{summarizeImportValue(row.case.input)}</td>
                  <td>{summarizeImportValue(row.case.expectedOutput)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
