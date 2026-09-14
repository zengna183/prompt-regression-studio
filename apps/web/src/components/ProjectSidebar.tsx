import { useState } from "react";
import type { CreateProject, Project } from "@ai-chat-eval/contracts";

import type { ActiveView } from "../App";
import { CreateProjectForm } from "./CreateForms";
import { EmptyState, ErrorState, LoadingState } from "./StatusViews";

interface ProjectSidebarProps {
  projects: Project[];
  selectedProjectId: string | null;
  activeView: ActiveView;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onNavigate: (view: ActiveView) => void;
  onSelect: (projectId: string) => void;
  onCreate: (input: CreateProject) => Promise<void>;
}

export function ProjectSidebar({
  projects,
  selectedProjectId,
  activeView,
  loading,
  error,
  onRetry,
  onNavigate,
  onSelect,
  onCreate,
}: ProjectSidebarProps) {
  const [creating, setCreating] = useState(false);

  async function handleCreate(input: CreateProject) {
    await onCreate(input);
    setCreating(false);
  }

  return (
    <aside className="project-sidebar" aria-label="项目导航">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          衡
        </span>
        <div>
          <strong>衡鉴</strong>
          <span>AI 对话评测平台</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label="主要功能">
        <button
          className={
            "primary-nav__item" + (activeView === "catalog" ? " primary-nav__item--active" : "")
          }
          type="button"
          onClick={() => onNavigate("catalog")}
          {...(activeView === "catalog" ? { "aria-current": "page" as const } : {})}
        >
          <span aria-hidden="true">P</span>
          <span>
            <strong>项目与 Prompt</strong>
            <small>管理版本和区段</small>
          </span>
        </button>
        <button
          className={
            "primary-nav__item" + (activeView === "diagnosis" ? " primary-nav__item--active" : "")
          }
          type="button"
          onClick={() => onNavigate("diagnosis")}
          {...(activeView === "diagnosis" ? { "aria-current": "page" as const } : {})}
        >
          <span aria-hidden="true">D</span>
          <span>
            <strong>回归诊断</strong>
            <small>上传评测包并归因</small>
          </span>
        </button>
      </nav>

      <div className="sidebar-heading">
        <div>
          <span className="eyebrow eyebrow--light">WORKSPACE</span>
          <h2>评测项目</h2>
        </div>
        <button
          className="sidebar-add"
          type="button"
          onClick={() => setCreating(true)}
          aria-label="创建项目"
          title="创建项目"
        >
          +
        </button>
      </div>

      {creating ? (
        <CreateProjectForm onSubmit={handleCreate} onCancel={() => setCreating(false)} />
      ) : null}

      <div className="project-list" aria-live="polite">
        {loading ? <LoadingState label="正在加载项目" /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={onRetry} /> : null}
        {!loading && !error && projects.length === 0 && !creating ? (
          <EmptyState
            title="还没有项目"
            description="先创建一个项目，集中管理同一产品的 Prompt。"
            action={
              <button
                className="button button--light"
                type="button"
                onClick={() => setCreating(true)}
              >
                创建第一个项目
              </button>
            }
          />
        ) : null}
        {!loading && !error
          ? projects.map((project) => {
              const selected = activeView === "catalog" && project.id === selectedProjectId;
              return (
                <button
                  key={project.id}
                  className={`project-item${selected ? " project-item--selected" : ""}`}
                  type="button"
                  onClick={() => onSelect(project.id)}
                  {...(selected ? { "aria-current": "page" as const } : {})}
                >
                  <span className="project-item__initial" aria-hidden="true">
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-item__text">
                    <strong>{project.name}</strong>
                    <small>{project.slug}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              );
            })
          : null}
      </div>

      <div className="sidebar-footer">
        <span className="environment-dot" aria-hidden="true" />
        <span>连接真实 API</span>
        <small>{import.meta.env.VITE_API_URL || "http://localhost:4000"}</small>
      </div>
    </aside>
  );
}
