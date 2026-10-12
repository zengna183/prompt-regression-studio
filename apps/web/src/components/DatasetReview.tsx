import { useEffect, useId, useState, type FormEvent } from "react";
import type {
  DatasetVersion,
  EvaluationCase,
  ReviewDatasetVersionRequest,
} from "@ai-chat-eval/contracts";

import { api, getErrorMessage } from "../api/client";
import { LoadingState } from "./StatusViews";

const PAGE_SIZE = 20;
type ReviewCase = {
  caseKey: string;
  name: string;
  inputText: string;
  expectedText: string;
  originalInput: unknown;
  originalExpected: unknown;
  metadata: Record<string, unknown>;
};

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

function editedValue(original: unknown, text: string, label: string): unknown {
  if (text === asText(original)) return original;
  if (typeof original === "string" || original === null || original === undefined) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} 原本是结构化 JSON，修改后仍须填写有效 JSON。`);
  }
}

export function DatasetReview({
  version,
  onChanged,
}: {
  version: DatasetVersion;
  onChanged: (version: DatasetVersion) => void;
}) {
  const id = useId();
  const [cases, setCases] = useState<ReviewCase[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [reviewerName, setReviewerName] = useState(version.reviewedBy ?? "");
  const [reviewNotes, setReviewNotes] = useState(version.reviewNotes ?? "");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .listDatasetCases(version.id)
      .then((items: EvaluationCase[]) => {
        if (controller.signal.aborted) return;
        setCases(
          items.map((item) => ({
            caseKey: item.caseKey,
            name: item.name ?? "",
            inputText: asText(item.input),
            expectedText: asText(item.expectedOutput),
            originalInput: item.input,
            originalExpected: item.expectedOutput,
            metadata: item.metadata,
          })),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(getErrorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [version.id]);

  function edit(caseKey: string, field: "name" | "inputText" | "expectedText", value: string) {
    setCases((current) =>
      current.map((item) => (item.caseKey === caseKey ? { ...item, [field]: value } : item)),
    );
    setReviewed((current) => {
      const next = new Set(current);
      next.delete(caseKey);
      return next;
    });
    setDirty(true);
  }

  function remove(caseKey: string) {
    setCases((current) => current.filter((item) => item.caseKey !== caseKey));
    setReviewed((current) => {
      const next = new Set(current);
      next.delete(caseKey);
      return next;
    });
    setDirty(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || loading || cases.length === 0 || reviewed.size !== cases.length) return;
    setBusy(true);
    setError(null);
    try {
      const payload: ReviewDatasetVersionRequest = {
        reviewerName: reviewerName.trim(),
        reviewNotes: reviewNotes.trim(),
        acknowledged: true,
        cases: cases.map((item, index) => {
          if (!item.inputText.trim()) throw new Error(`第 ${index + 1} 条用例的输入不能为空。`);
          const input = editedValue(item.originalInput, item.inputText, `第 ${index + 1} 条输入`);
          const expectedOutput = item.expectedText.trim()
            ? editedValue(item.originalExpected, item.expectedText, `第 ${index + 1} 条参考回答`)
            : undefined;
          return {
            caseKey: item.caseKey,
            ...(item.name.trim() ? { name: item.name.trim() } : {}),
            input,
            ...(expectedOutput === undefined ? {} : { expectedOutput }),
            metadata: item.metadata,
          };
        }),
      };
      const saved = await api.reviewDatasetVersion(version.id, payload);
      setDirty(false);
      onChanged(saved);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (busy || dirty || !version.reviewedAt) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.publishDatasetVersion(version.id));
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const currentPage = Math.min(page, Math.max(0, Math.ceil(cases.length / PAGE_SIZE) - 1));
  const shown = cases.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const editable = version.status === "draft";
  return (
    <section className="dataset-import" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>查看与审核 v{version.version}</h3>
      <p>
        {version.status !== "draft"
          ? "此版本已发布，只能查看。"
          : version.reviewedAt
            ? `已由 ${version.reviewedBy ?? "审核人"} 确认；仍可修改后生成新版本。`
            : "逐条查看并勾选确认。修改会创建新版本，原草稿保留。"}
      </p>
      {loading ? <LoadingState label="正在加载用例" /> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading ? (
        <form onSubmit={(event) => void submit(event)}>
          <p>
            {editable ? `已确认 ${reviewed.size} / ${cases.length} 条；` : ""}当前第{" "}
            {currentPage + 1} / {Math.max(1, Math.ceil(cases.length / PAGE_SIZE))} 页
          </p>
          {shown.map((item, index) => (
            <fieldset
              className="dataset-review-case"
              key={item.caseKey}
              disabled={busy || !editable}
            >
              <legend>
                {currentPage * PAGE_SIZE + index + 1}. {item.caseKey}
              </legend>
              <label htmlFor={`${id}-${item.caseKey}-name`}>
                名称
                <input
                  id={`${id}-${item.caseKey}-name`}
                  maxLength={240}
                  value={item.name}
                  onChange={(event) => edit(item.caseKey, "name", event.target.value)}
                />
              </label>
              <label htmlFor={`${id}-${item.caseKey}-input`}>
                用户输入
                <textarea
                  id={`${id}-${item.caseKey}-input`}
                  rows={3}
                  required
                  value={item.inputText}
                  onChange={(event) => edit(item.caseKey, "inputText", event.target.value)}
                />
              </label>
              <label htmlFor={`${id}-${item.caseKey}-expected`}>
                参考回答（可留空）
                <textarea
                  id={`${id}-${item.caseKey}-expected`}
                  rows={3}
                  value={item.expectedText}
                  onChange={(event) => edit(item.caseKey, "expectedText", event.target.value)}
                />
              </label>
              <label className="dataset-review-case__check">
                <input
                  type="checkbox"
                  checked={reviewed.has(item.caseKey)}
                  onChange={(event) => {
                    setReviewed((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.caseKey);
                      else next.delete(item.caseKey);
                      return next;
                    });
                  }}
                />
                我已核对这条用例和参考回答
              </label>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => remove(item.caseKey)}
                disabled={cases.length <= 1}
              >
                移除这条
              </button>
            </fieldset>
          ))}
          {cases.length > PAGE_SIZE ? (
            <div className="dataset-import__actions">
              <button
                type="button"
                className="button button--quiet"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={(currentPage + 1) * PAGE_SIZE >= cases.length}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
          {editable && (!version.reviewedAt || dirty) ? (
            <>
              <label htmlFor={`${id}-reviewer`}>
                审核人（自填；当前尚无个人登录验证）
                <input
                  id={`${id}-reviewer`}
                  required
                  minLength={2}
                  maxLength={120}
                  value={reviewerName}
                  disabled={busy}
                  onChange={(event) => {
                    setReviewerName(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label htmlFor={`${id}-notes`}>
                审核说明（可选）
                <textarea
                  id={`${id}-notes`}
                  rows={3}
                  maxLength={2000}
                  value={reviewNotes}
                  disabled={busy}
                  onChange={(event) => {
                    setReviewNotes(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <button
                className="button button--secondary"
                type="submit"
                disabled={
                  busy ||
                  cases.length === 0 ||
                  reviewed.size !== cases.length ||
                  reviewerName.trim().length < 2
                }
              >
                {busy ? "正在保存审核…" : "确认审核并保存"}
              </button>
            </>
          ) : null}
        </form>
      ) : null}
      {editable && version.reviewedAt ? (
        <button
          className="button button--primary"
          type="button"
          disabled={busy || dirty}
          onClick={() => void publish()}
        >
          {busy ? "正在发布…" : "发布已审核版本"}
        </button>
      ) : null}
    </section>
  );
}
