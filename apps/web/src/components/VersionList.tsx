import { useEffect, useState } from "react";
import type { CreatePromptVersion, Prompt, PromptVersion } from "@ai-chat-eval/contracts";

import { api, getErrorMessage } from "../api/client";
import { PromptVersionEditor } from "./PromptVersionEditor";
import { EmptyState, ErrorState, LoadingState } from "./StatusViews";

const STATUS_LABELS: Record<PromptVersion["status"], string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function VersionList({ prompt }: { prompt: Prompt }) {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editorParent, setEditorParent] = useState<PromptVersion | null | undefined>(undefined);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setEditorParent(undefined);

    void api
      .listPromptVersions(prompt.id, controller.signal)
      .then((items) => {
        setVersions([...items].sort((a, b) => b.version - a.version));
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(getErrorMessage(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [prompt.id, reloadKey]);

  async function handleCreateVersion(input: CreatePromptVersion) {
    const created = await api.createPromptVersion(prompt.id, input);
    setVersions((current) => [created, ...current]);
    setEditorParent(undefined);
  }

  async function handlePublish(version: PromptVersion) {
    if (
      !window.confirm(`确认发布 ${prompt.name} 的 V${version.version}？发布后可用于正式评测实验。`)
    ) {
      return;
    }

    setPublishingId(version.id);
    setActionError(null);
    try {
      await api.publishPromptVersion(version.id);
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setActionError(getErrorMessage(caught));
    } finally {
      setPublishingId(null);
    }
  }

  if (editorParent !== undefined) {
    return (
      <PromptVersionEditor
        prompt={prompt}
        parentVersion={editorParent}
        onSubmit={handleCreateVersion}
        onCancel={() => setEditorParent(undefined)}
      />
    );
  }

  return (
    <section className="versions" aria-labelledby="versions-title">
      <div className="section-header">
        <div>
          <span className="eyebrow">VERSION CONTROL</span>
          <h2 id="versions-title">Prompt 版本</h2>
          <p>版本保存完整区块结构；发布之后，实验才能明确引用这份不可变内容。</p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => setEditorParent(versions[0] ?? null)}
          disabled={loading}
        >
          ＋ 新建版本
        </button>
      </div>

      {actionError ? <ErrorState message={actionError} /> : null}
      {loading ? <LoadingState label="正在加载版本" /> : null}
      {!loading && error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
      ) : null}
      {!loading && !error && versions.length === 0 ? (
        <EmptyState
          title="还没有 Prompt 版本"
          description="创建一个由独立区块组成的版本。它会先保存为草稿，确认后再发布。"
          action={
            <button
              className="button button--primary"
              type="button"
              onClick={() => setEditorParent(null)}
            >
              创建第一个版本
            </button>
          }
        />
      ) : null}

      {!loading && !error && versions.length > 0 ? (
        <div className="version-table-wrap">
          <table className="version-table">
            <thead>
              <tr>
                <th scope="col">版本</th>
                <th scope="col">状态</th>
                <th scope="col">结构</th>
                <th scope="col">修改说明</th>
                <th scope="col">创建时间</th>
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>
                    <strong className="version-number">V{version.version}</strong>
                    <code className="hash" title={version.contentHash}>
                      {version.contentHash.slice(0, 8)}
                    </code>
                  </td>
                  <td>
                    <span className={`status-pill status-pill--${version.status}`}>
                      {STATUS_LABELS[version.status]}
                    </span>
                  </td>
                  <td>
                    <strong>{version.blocks.length} 个区块</strong>
                    <small>
                      {version.blocks.reduce((sum, block) => sum + block.content.length, 0)} 字符
                    </small>
                  </td>
                  <td className="summary-cell">{version.changeSummary || "未填写修改说明"}</td>
                  <td>
                    <span>{formatDate(version.createdAt)}</span>
                    {version.publishedAt ? (
                      <small>发布于 {formatDate(version.publishedAt)}</small>
                    ) : null}
                  </td>
                  <td className="table-actions">
                    {version.status === "draft" ? (
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => void handlePublish(version)}
                        disabled={publishingId !== null}
                      >
                        {publishingId === version.id ? "发布中…" : "发布"}
                      </button>
                    ) : null}
                    <button
                      className="button button--quiet"
                      type="button"
                      onClick={() => setEditorParent(version)}
                    >
                      基于此版本新建
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
