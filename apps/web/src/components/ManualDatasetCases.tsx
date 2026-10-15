import { useState, type FormEvent } from "react";
import type { DatasetVersion } from "@ai-chat-eval/contracts";
import { api, getErrorMessage } from "../api/client";

const newCase = () => ({
  caseKey: `case-${crypto.randomUUID()}`,
  name: "",
  input: "",
  expectedOutput: "",
});

export function ManualDatasetCases({
  datasetId,
  onSaved,
}: {
  datasetId: string;
  onSaved: (version: DatasetVersion) => void;
}) {
  const [cases, setCases] = useState(() => [newCase()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function change(index: number, field: "name" | "input" | "expectedOutput", value: string) {
    setCases((current) =>
      current.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (cases.some((item) => !item.input.trim())) {
      setError("每条用例都需要填写对话输入，不能只有空格。");
      return;
    }
    setBusy(true);
    try {
      const version = await api.createDatasetVersion(datasetId, {
        source: "manual",
        changeSummary: "通过网页手动录入用例",
        cases: cases.map((item) => ({
          caseKey: item.caseKey,
          input: item.input.trim(),
          ...(item.name.trim() ? { name: item.name.trim() } : {}),
          ...(item.expectedOutput.trim() ? { expectedOutput: item.expectedOutput.trim() } : {}),
        })),
      });
      setCases([newCase()]);
      onSaved(version);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="flow-card">
      <summary>手动添加用例（无需准备文件）</summary>
      <form className="flow-form" onSubmit={(event) => void save(event)}>
        <p>每次保存会创建独立草稿，不覆盖或自动合并已有版本。保存后仍需审核并发布。</p>
        <fieldset disabled={busy} className="flow-stack">
          <legend>本版用例</legend>
          {cases.map((item, index) => (
            <section key={item.caseKey} className="flow-card flow-form">
              <h3>用例 {index + 1}</h3>
              <label>
                用例名称（可选）
                <input
                  maxLength={240}
                  value={item.name}
                  onChange={(e) => change(index, "name", e.target.value)}
                />
              </label>
              <label>
                对话输入
                <textarea
                  required
                  maxLength={20000}
                  rows={4}
                  value={item.input}
                  onChange={(e) => change(index, "input", e.target.value)}
                  placeholder="输入用户会向 AI 提出的问题。"
                />
              </label>
              <label>
                期望回答或判定依据（可选）
                <textarea
                  maxLength={20000}
                  rows={3}
                  value={item.expectedOutput}
                  onChange={(e) => change(index, "expectedOutput", e.target.value)}
                />
              </label>
              <button
                className="button button--quiet"
                type="button"
                disabled={cases.length <= 1}
                onClick={() => setCases((current) => current.filter((_, i) => i !== index))}
              >
                移除用例 {index + 1}
              </button>
            </section>
          ))}
          <button
            className="button button--secondary"
            type="button"
            disabled={cases.length >= 50}
            onClick={() => setCases((current) => [...current, newCase()])}
          >
            再加一条用例
          </button>
          <small>手动表单每次最多 50 条；批量数据请使用文件导入。</small>
          <button className="button button--primary" type="submit">
            {busy ? "正在保存…" : "保存手动用例草稿"}
          </button>
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
