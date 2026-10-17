import { useCallback, useState, type FormEvent } from "react";
import type { Project, FrameworkDefinition, FrameworkVersion } from "@ai-chat-eval/contracts";
import { api, getErrorMessage } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";
import { useProjectAccess } from "./ProjectAccess";

export function FrameworkWorkspace({ project }: { project: Project }) {
  const { canEdit } = useProjectAccess();
  const resource = useResource(
    useCallback((signal: AbortSignal) => api.listFrameworks(project.id, signal), [project.id]),
  );
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedId = selected || resource.data?.[0]?.id || "";
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createFramework(project.id, {
        name: name.trim(),
        key: `rubric-${crypto.randomUUID().slice(0, 12)}`,
      });
      setSelected(created.id);
      setName("");
      resource.reload();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace flow-workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb">{project.name} / 评判标准</div>
          <h1>定义怎样才算回答得好</h1>
          <p>设置评分维度、权重和分数说明。修改会保存为新版本，历史实验使用的标准不会被改变。</p>
        </div>
      </header>
      {canEdit && (
        <form className="flow-card flow-form" onSubmit={(e) => void create(e)}>
          <h2>新建一套评判标准</h2>
          <label>
            名称
            <input
              required
              minLength={2}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：客服对话质量标准"
              disabled={busy}
            />
          </label>
          <button className="button button--secondary" disabled={busy}>
            创建标准
          </button>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </form>
      )}
      {resource.loading && <LoadingState />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && resource.data.length > 0 && (
        <>
          <label>
            选择评判标准
            <select value={selectedId} onChange={(e) => setSelected(e.target.value)}>
              {resource.data.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <FrameworkVersions key={selectedId} frameworkId={selectedId} />
        </>
      )}
    </main>
  );
}

function FrameworkVersions({ frameworkId }: { frameworkId: string }) {
  const { canEdit } = useProjectAccess();
  const resource = useResource(
    useCallback(
      (signal: AbortSignal) => api.listFrameworkVersions(frameworkId, signal),
      [frameworkId],
    ),
  );
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const source = resource.data?.find((item) => item.id === selected) ?? resource.data?.[0];
  async function publish() {
    if (!source || busy || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      await api.publishFrameworkVersion(source.id);
      setMessage("版本已发布，可以在新实验中选择。");
      resource.reload();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flow-stack">
      {resource.loading && <LoadingState />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && (
        <>
          {resource.data.length > 0 && (
            <label>
              查看或作为修改基础的版本
              <select
                value={source?.id ?? ""}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setMessage("");
                }}
              >
                {resource.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    v{item.version} ·{" "}
                    {item.status === "published"
                      ? "已发布"
                      : item.status === "draft"
                        ? "草稿"
                        : "已归档"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {source?.status === "draft" && canEdit && (
            <div className="flow-stack">
              <p>
                发布的是当前已保存的 v{source.version}
                ，不包含下方编辑区尚未保存的修改。需要修改时，请先保存新草稿。
              </p>
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void publish()}
              >
                发布已保存的 v{source.version}
              </button>
            </div>
          )}
          {source && (
            <details className="flow-card">
              <summary>查看 v{source.version} 已保存的评分内容</summary>
              {source.definition.dimensions.map((dimension) => (
                <section key={dimension.id}>
                  <h3>
                    {dimension.name} · 权重 {(dimension.weight * 100).toFixed(1)}%
                  </h3>
                  <p>{dimension.description}</p>
                  <ul>
                    {dimension.scoringGuide.map((guide) => (
                      <li key={guide.score}>
                        {guide.score} 分：{guide.description}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </details>
          )}
          {message && <p role="status">{message}</p>}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {canEdit && (
            <FrameworkEditor
              key={source?.id ?? "new"}
              frameworkId={frameworkId}
              source={source}
              onSaved={(version) => {
                setSelected(version.id);
                setMessage("草稿已保存。核对内容后点击发布，才会用于新实验。");
                resource.reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

const initialDefinition: FrameworkDefinition = {
  levels: [{ id: "general", name: "通用对话", description: "适用于本项目的对话评测" }],
  dimensions: [
    {
      id: "accuracy",
      name: "准确性",
      description: "回答应符合提供的事实和业务规则，不编造信息。",
      weight: 1,
      scoringGuide: [
        { score: 0, description: "关键事实错误或编造内容。" },
        { score: 5, description: "准确完整，没有不受支持的结论。" },
      ],
    },
  ],
};

export function FrameworkEditor({
  frameworkId,
  source,
  onSaved,
}: {
  frameworkId: string;
  source: FrameworkVersion | undefined;
  onSaved: (version: FrameworkVersion) => void;
}) {
  const { canEdit } = useProjectAccess();
  const [definition, setDefinition] = useState<FrameworkDefinition>(() =>
    structuredClone(source?.definition ?? initialDefinition),
  );
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = definition.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  function change(index: number, patch: Partial<FrameworkDefinition["dimensions"][number]>) {
    setDefinition((current) => ({
      ...current,
      dimensions: current.dimensions.map((dimension, i) =>
        i === index ? { ...dimension, ...patch } : dimension,
      ),
    }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit) return;
    setError(null);
    if (Math.abs(total - 1) > 0.00001) {
      setError("各维度的权重加起来应为 100%。");
      return;
    }
    if (
      definition.dimensions.some(
        (d) => new Set(d.scoringGuide.map((g) => g.score)).size !== d.scoringGuide.length,
      )
    ) {
      setError("同一维度的分数不能重复。");
      return;
    }
    setBusy(true);
    try {
      onSaved(
        await api.createFrameworkVersion(frameworkId, {
          definition,
          ...(source ? { parentVersionId: source.id } : {}),
          changeSummary: summary.trim() || "通过网页调整评判标准",
        }),
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flow-card flow-form" onSubmit={(e) => void save(e)}>
      <h2>{source ? `基于 v${source.version} 保存新草稿` : "设置第一版标准"}</h2>
      <p>示例文字仅供起步，请根据你的业务修改。分数支持 0～5；至少写清两个不同分数的含义。</p>
      <fieldset disabled={busy || !canEdit} className="flow-stack">
        <legend>评分维度</legend>
        {definition.dimensions.map((dimension, index) => (
          <section className="flow-card flow-form" key={dimension.id}>
            <label>
              维度名称
              <input
                required
                maxLength={120}
                value={dimension.name}
                onChange={(e) => change(index, { name: e.target.value })}
              />
            </label>
            <label>
              评判说明
              <textarea
                required
                maxLength={2000}
                value={dimension.description}
                onChange={(e) => change(index, { description: e.target.value })}
              />
            </label>
            <label>
              权重（%）
              <input
                type="number"
                required
                min={0}
                max={100}
                step={1}
                value={Math.round(dimension.weight * 100)}
                onChange={(e) => change(index, { weight: Number(e.target.value) / 100 })}
              />
            </label>
            {dimension.scoringGuide.map((guide, guideIndex) => (
              <div className="flow-row" key={guideIndex}>
                <label>
                  分数
                  <input
                    type="number"
                    required
                    min={0}
                    max={5}
                    step={1}
                    value={guide.score}
                    onChange={(e) =>
                      change(index, {
                        scoringGuide: dimension.scoringGuide.map((g, i) =>
                          i === guideIndex ? { ...g, score: Number(e.target.value) } : g,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  该分数表示什么
                  <textarea
                    required
                    maxLength={2000}
                    value={guide.description}
                    onChange={(e) =>
                      change(index, {
                        scoringGuide: dimension.scoringGuide.map((g, i) =>
                          i === guideIndex ? { ...g, description: e.target.value } : g,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={dimension.scoringGuide.length <= 2}
                  onClick={() =>
                    change(index, {
                      scoringGuide: dimension.scoringGuide.filter((_, i) => i !== guideIndex),
                    })
                  }
                >
                  移除此分数
                </button>
              </div>
            ))}
            <div className="flow-actions">
              <button
                type="button"
                className="button button--secondary"
                disabled={dimension.scoringGuide.length >= 6}
                onClick={() => {
                  const score = [0, 1, 2, 3, 4, 5].find(
                    (n) => !dimension.scoringGuide.some((g) => g.score === n),
                  );
                  if (score !== undefined)
                    change(index, {
                      scoringGuide: [...dimension.scoringGuide, { score, description: "" }],
                    });
                }}
              >
                添加分数说明
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={definition.dimensions.length <= 1}
                onClick={() =>
                  setDefinition((current) => ({
                    ...current,
                    dimensions: current.dimensions.filter((_, i) => i !== index),
                  }))
                }
              >
                移除此维度
              </button>
            </div>
          </section>
        ))}
        <button
          type="button"
          className="button button--secondary"
          onClick={() =>
            setDefinition((current) => ({
              ...current,
              dimensions: [
                ...current.dimensions,
                {
                  id: `d_${crypto.randomUUID().replaceAll("-", "")}`,
                  name: "",
                  description: "",
                  weight: 0,
                  scoringGuide: [
                    { score: 0, description: "" },
                    { score: 5, description: "" },
                  ],
                },
              ],
            }))
          }
        >
          增加评测维度
        </button>
        <p role="status">权重合计：{Math.round(total * 100)}%（应为 100%）</p>
        <label>
          本次修改说明
          <input maxLength={1000} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        <button className="button button--primary" type="submit">
          保存为新草稿
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
