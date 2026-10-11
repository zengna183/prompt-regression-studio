import { useEffect, useId, useState, type FormEvent } from "react";
import type { DatasetVersion, EvaluationCase } from "@ai-chat-eval/contracts";

import { api, getErrorMessage } from "../api/client";
import { summarizeImportValue } from "../lib/datasetImport";

export function DatasetGeneration({
  datasetId,
  onSaved,
}: {
  datasetId: string;
  onSaved: (version: DatasetVersion) => void;
}) {
  const id = useId();
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<DatasetVersion | null>(null);
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .datasetGenerationAvailability(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setAvailable(status.enabled);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(getErrorMessage(caught));
      });
    return () => controller.abort();
  }, []);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    setCases([]);
    try {
      const version = await api.generateDatasetCases(datasetId, { brief: brief.trim(), count });
      setSaved(version);
      onSaved(version);
      try {
        setCases(await api.listDatasetCases(version.id));
      } catch {
        setError("草稿已保存，但预览暂时无法加载。请稍后在版本列表查看。");
      }
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dataset-import" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>AI 生成候选用例</h2>
      <p>
        描述要测试的对话场景。生成会调用后台配置的模型并保存为待审核草稿，不会自动发布或用于正式评测。
      </p>
      {available === false ? (
        <p role="status">管理员尚未配置生成模型。设置 DATASET_GENERATION_MODEL 后即可使用。</p>
      ) : null}
      <form onSubmit={(event) => void generate(event)}>
        <label htmlFor={`${id}-brief`}>
          评测场景与重点
          <textarea
            id={`${id}-brief`}
            rows={5}
            required
            minLength={10}
            maxLength={2000}
            value={brief}
            disabled={busy || available !== true}
            placeholder="例如：测试客服助手处理退款咨询，覆盖政策不明确、超期申请、情绪激动和需要转人工的情况。不要包含真实个人信息。"
            onChange={(event) => setBrief(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-count`}>
          用例数量（1～10）
          <input
            id={`${id}-count`}
            type="number"
            min={1}
            max={10}
            step={1}
            value={count}
            disabled={busy || available !== true}
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </label>
        <p className="dataset-import__hint">
          场景说明会发送给所配置的模型，并记录在版本来源中；请勿输入密码或真实用户隐私。
        </p>
        <button
          className="button button--secondary"
          type="submit"
          disabled={
            busy ||
            available !== true ||
            brief.trim().length < 10 ||
            !Number.isInteger(count) ||
            count < 1 ||
            count > 10
          }
        >
          {busy ? "正在生成并保存草稿…" : "生成候选用例"}
        </button>
      </form>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <div className="dataset-import__preview" aria-live="polite">
          <h3>
            草稿 v{saved.version} 已保存：{saved.caseCount} 条候选用例
          </h3>
          <p>来源：AI 生成；模型与原始场景已记录在版本中。请人工核对内容，不要直接当作正确答案。</p>
          {cases.length ? (
            <div className="version-table-wrap">
              <table className="version-table">
                <thead>
                  <tr>
                    <th>编号 / 名称</th>
                    <th>输入</th>
                    <th>参考回答</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.caseKey}
                        <br />
                        {item.name}
                      </td>
                      <td>{summarizeImportValue(item.input)}</td>
                      <td>{summarizeImportValue(item.expectedOutput)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
