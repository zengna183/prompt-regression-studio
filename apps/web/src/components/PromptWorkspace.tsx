import { useEffect, useMemo, useState } from "react";
import type { CreatePrompt, Project, Prompt } from "@ai-chat-eval/contracts";

import { api, getErrorMessage } from "../api/client";
import { CreatePromptForm } from "./CreateForms";
import { EmptyState, ErrorState, LoadingState } from "./StatusViews";
import { VersionList } from "./VersionList";

export function PromptWorkspace({ project }: { project: Project }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPrompts([]);
    setSelectedPromptId(null);
    setCreating(false);

    void api
      .listPrompts(project.id, controller.signal)
      .then((items) => {
        setPrompts(items);
        setSelectedPromptId((current) =>
          current && items.some((item) => item.id === current) ? current : (items[0]?.id ?? null),
        );
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
  }, [project.id, reloadKey]);

  const selectedPrompt = useMemo(
    () => prompts.find((prompt) => prompt.id === selectedPromptId) ?? null,
    [prompts, selectedPromptId],
  );

  async function handleCreate(input: CreatePrompt) {
    const created = await api.createPrompt(project.id, input);
    setPrompts((current) => [...current, created]);
    setSelectedPromptId(created.id);
    setCreating(false);
  }

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb">
            <span>项目</span>
            <span aria-hidden="true">/</span>
            <strong>{project.name}</strong>
          </div>
          <h1>{project.name}</h1>
          <p>{project.description || "管理这个项目中的 Prompt 及其可复现版本。"}</p>
        </div>
        <div className="header-chip">
          <span className="environment-dot" aria-hidden="true" />
          <div>
            <strong>版本库</strong>
            <small>所有变更可追溯</small>
          </div>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="prompt-nav" aria-label="Prompt 列表">
          <div className="prompt-nav__header">
            <div>
              <span className="eyebrow">PROMPTS</span>
              <h2>Prompt</h2>
            </div>
            <button
              className="icon-button icon-button--filled"
              type="button"
              onClick={() => setCreating(true)}
              aria-label="新建 Prompt"
            >
              +
            </button>
          </div>

          {loading ? <LoadingState label="正在加载 Prompt" /> : null}
          {!loading && error ? (
            <ErrorState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
          ) : null}
          {!loading && !error && prompts.length === 0 ? (
            <EmptyState
              title="还没有 Prompt"
              description="为一种具体对话任务创建 Prompt。"
              action={
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setCreating(true)}
                >
                  新建 Prompt
                </button>
              }
            />
          ) : null}
          {!loading && !error ? (
            <div className="prompt-list">
              {prompts.map((prompt) => {
                const selected = prompt.id === selectedPromptId;
                return (
                  <button
                    className={`prompt-item${selected ? " prompt-item--selected" : ""}`}
                    key={prompt.id}
                    type="button"
                    onClick={() => setSelectedPromptId(prompt.id)}
                    {...(selected ? { "aria-current": "true" as const } : {})}
                  >
                    <span className="prompt-item__icon" aria-hidden="true">
                      P
                    </span>
                    <span>
                      <strong>{prompt.name}</strong>
                      <small>{prompt.key}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </aside>

        <div className="content-panel">
          {creating ? (
            <CreatePromptForm onSubmit={handleCreate} onCancel={() => setCreating(false)} />
          ) : null}
          {!creating && selectedPrompt ? (
            <>
              <div className="prompt-overview">
                <div>
                  <span className="eyebrow">SELECTED PROMPT</span>
                  <h2>{selectedPrompt.name}</h2>
                  <p>{selectedPrompt.description || "尚未填写用途说明。"}</p>
                </div>
                <code>{selectedPrompt.key}</code>
              </div>
              <VersionList key={selectedPrompt.id} prompt={selectedPrompt} />
            </>
          ) : null}
          {!creating && !loading && !error && !selectedPrompt && prompts.length > 0 ? (
            <EmptyState title="请选择一个 Prompt" description="选择左侧 Prompt 后管理它的版本。" />
          ) : null}
        </div>
      </div>
    </main>
  );
}
