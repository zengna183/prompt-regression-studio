import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreateProject, Project } from "@ai-chat-eval/contracts";

import { api, ApiError, getErrorMessage, setApiToken } from "./api/client";
import { DiagnosisWorkspace } from "./components/DiagnosisWorkspace";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { PromptWorkspace } from "./components/PromptWorkspace";
import { EmptyState } from "./components/StatusViews";
import { DatasetWorkspace } from "./components/DatasetWorkspace";
import { ModelWorkspace } from "./components/ModelWorkspace";
import { FrameworkWorkspace } from "./components/FrameworkWorkspace";
import { ExperimentWorkspace } from "./components/ExperimentWorkspace";
import { WorkflowHome } from "./components/WorkflowHome";

export type ActiveView =
  "home" | "catalog" | "diagnosis" | "datasets" | "models" | "frameworks" | "experiments";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeView, setActiveView] = useState<ActiveView>("home");
  const [needsAccess, setNeedsAccess] = useState(false);
  const [token, setToken] = useState("");
  const projectRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    projectRequest.current = controller;
    setLoading(true);
    setError(null);

    void api
      .listProjects(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setNeedsAccess(false);
        setProjects(items);
        setSelectedProjectId((current) =>
          current && items.some((project) => project.id === current)
            ? current
            : (items[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) setNeedsAccess(true);
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(getErrorMessage(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reloadKey]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const handleCreateProject = useCallback(async (input: CreateProject) => {
    const created = await api.createProject(input);
    setProjects((current) => [...current, created]);
    setSelectedProjectId(created.id);
    setActiveView("home");
  }, []);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setActiveView("home");
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <ProjectSidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        activeView={activeView}
        loading={loading}
        error={error}
        onRetry={() => setReloadKey((value) => value + 1)}
        onNavigate={setActiveView}
        onSelect={handleSelectProject}
        onCreate={handleCreateProject}
      />
      <div id="main-content" className="app-content">
        <div className="access-bar">
          <span>当前项目：{selectedProject?.name ?? "尚未选择"}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              projectRequest.current?.abort();
              setLoading(false);
              setError(null);
              setApiToken("");
              setToken("");
              setProjects([]);
              setSelectedProjectId(null);
              setNeedsAccess(true);
              setActiveView("home");
            }}
          >
            设置 / 清除访问凭证
          </button>
        </div>
        {needsAccess ? (
          <main className="workspace">
            <form
              className="flow-card flow-form"
              onSubmit={(e) => {
                e.preventDefault();
                setApiToken(token);
                setToken("");
                setReloadKey((value) => value + 1);
              }}
            >
              <h1>连接受保护的评测服务</h1>
              <p>
                填写部署管理员提供的访问凭证。凭证只保留在本次页面会话中，刷新后需要重新输入；这不是团队账号登录。
              </p>
              <label>
                访问凭证
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  minLength={32}
                  maxLength={512}
                />
              </label>
              <button className="button button--primary" disabled={loading}>
                连接服务
              </button>
              <p>本地服务未设置凭证时，可留空连接。</p>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          </main>
        ) : activeView === "diagnosis" ? (
          <DiagnosisWorkspace />
        ) : activeView === "home" && selectedProject ? (
          <WorkflowHome
            key={selectedProject.id}
            project={selectedProject}
            onNavigate={setActiveView}
          />
        ) : activeView === "models" && selectedProject ? (
          <ModelWorkspace key={selectedProject.id} project={selectedProject} />
        ) : activeView === "frameworks" && selectedProject ? (
          <FrameworkWorkspace key={selectedProject.id} project={selectedProject} />
        ) : activeView === "experiments" && selectedProject ? (
          <ExperimentWorkspace key={selectedProject.id} project={selectedProject} />
        ) : activeView === "datasets" && selectedProject ? (
          <DatasetWorkspace key={selectedProject.id} project={selectedProject} />
        ) : selectedProject ? (
          <PromptWorkspace key={selectedProject.id} project={selectedProject} />
        ) : !loading && !error ? (
          <div className="welcome-state">
            <EmptyState
              title="从一个评测项目开始"
              description="项目用于隔离 Prompt、数据集、评判标准与实验记录。请在左侧创建项目。"
            />
          </div>
        ) : (
          <div className="welcome-state" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
