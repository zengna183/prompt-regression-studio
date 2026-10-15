import { useEffect, useId, useState, type FormEvent } from "react";
import type { Dataset, DatasetVersion, Project } from "@ai-chat-eval/contracts";

import { api, getErrorMessage } from "../api/client";
import { DatasetImport } from "./DatasetImport";
import { DatasetGeneration } from "./DatasetGeneration";
import { DatasetReview } from "./DatasetReview";
import { ManualDatasetCases } from "./ManualDatasetCases";
import { EmptyState, ErrorState, LoadingState } from "./StatusViews";

export function DatasetWorkspace({ project }: { project: Project }) {
  const id = useId();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .listDatasets(project.id, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setDatasets(items);
        setSelectedId((current) =>
          items.some((item) => item.id === current) ? current : (items[0]?.id ?? ""),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(getErrorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, reload]);
  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await api.createDataset(project.id, {
        key: key.trim() || `dataset-${crypto.randomUUID()}`,
        name: name.trim(),
      });
      setDatasets((current) => [...current, created]);
      setSelectedId(created.id);
      setName("");
      setKey("");
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setCreating(false);
    }
  }
  return (
    <main className="workspace dataset-workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb">{project.name} / 评测集</div>
          <h1>评测集</h1>
          <p>导入对话样本，或让 AI 建议候选用例；每次保存都保留独立版本和来源。</p>
        </div>
      </header>
      {loading ? <LoadingState label="正在加载评测集" /> : null}
      {error ? (
        <ErrorState message={error} onRetry={() => setReload((value) => value + 1)} />
      ) : null}
      {!loading ? (
        <>
          <form className="dataset-create" onSubmit={(event) => void create(event)}>
            <h2>新建评测集</h2>
            <label htmlFor={`${id}-name`}>
              名称
              <input
                id={`${id}-name`}
                required
                minLength={2}
                maxLength={120}
                value={name}
                disabled={creating}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：客服退款对话"
              />
            </label>
            <label htmlFor={`${id}-key`}>
              英文标识（可选，留空自动生成）
              <input
                id={`${id}-key`}
                minLength={2}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                value={key}
                disabled={creating}
                onChange={(event) => setKey(event.target.value)}
                placeholder="例如：support-refund"
              />
              <small>用于开发者接入，支持小写字母、数字和短横线。</small>
            </label>
            <button className="button button--secondary" disabled={creating} type="submit">
              {creating ? "正在创建…" : "创建评测集"}
            </button>
          </form>
          {datasets.length === 0 ? (
            <EmptyState
              title="还没有评测集"
              description="先创建评测集，再导入 JSON 或 CSV 对话样本。"
            />
          ) : (
            <>
              <label htmlFor={`${id}-dataset`}>
                当前评测集
                <select
                  id={`${id}-dataset`}
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}（{dataset.key}）
                    </option>
                  ))}
                </select>
              </label>
              {selectedId ? (
                <DatasetImportPanel
                  key={selectedId}
                  projectId={project.id}
                  datasetId={selectedId}
                />
              ) : null}
            </>
          )}
        </>
      ) : null}
    </main>
  );
}
function DatasetImportPanel({ datasetId, projectId }: { datasetId: string; projectId: string }) {
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .listDatasetVersions(datasetId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setVersions(items);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(getErrorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [datasetId, reload]);
  const selectedVersion = versions.find((version) => version.id === openVersionId);
  return (
    <>
      <ManualDatasetCases
        datasetId={datasetId}
        onSaved={(version) => {
          setVersions((current) => [version, ...current.filter((item) => item.id !== version.id)]);
          setOpenVersionId(version.id);
          setReload((value) => value + 1);
        }}
      />
      <DatasetImport
        datasetId={datasetId}
        onSaved={(version) => {
          setVersions((current) => [version, ...current.filter((item) => item.id !== version.id)]);
          setReload((value) => value + 1);
        }}
      />
      <DatasetGeneration
        datasetId={datasetId}
        projectId={projectId}
        onSaved={(version) => {
          setVersions((current) => [version, ...current.filter((item) => item.id !== version.id)]);
          setReload((value) => value + 1);
        }}
      />
      <section className="dataset-versions">
        <h2>已保存的版本</h2>
        {loading ? (
          <LoadingState label="正在加载版本" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => setReload((value) => value + 1)} />
        ) : versions.length === 0 ? (
          <p>暂无版本，导入后会在这里保留草稿。</p>
        ) : (
          <ul>
            {versions.map((version) => (
              <li key={version.id}>
                v{version.version} ·{" "}
                {version.status === "draft"
                  ? version.reviewedAt
                    ? "已审核待发布"
                    : "待审核草稿"
                  : version.status === "published"
                    ? "已发布"
                    : "已归档"}{" "}
                · {version.caseCount} 条 · {version.changeSummary ?? "无变更说明"}
                {version.source === "ai_generated" &&
                typeof version.generationProvenance === "object" &&
                version.generationProvenance !== null &&
                "model" in version.generationProvenance &&
                typeof version.generationProvenance.model === "string"
                  ? ` · 模型：${version.generationProvenance.model}`
                  : null}
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() =>
                    setOpenVersionId((current) => (current === version.id ? null : version.id))
                  }
                >
                  {openVersionId === version.id
                    ? "收起"
                    : version.status === "draft"
                      ? "查看并审核"
                      : "查看"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selectedVersion ? (
        <DatasetReview
          key={selectedVersion.id}
          version={selectedVersion}
          onChanged={(version) => {
            setVersions((current) => [
              version,
              ...current.filter((item) => item.id !== version.id),
            ]);
            setOpenVersionId(version.id);
            setReload((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}
