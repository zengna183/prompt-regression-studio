import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreateProject, Project } from "@ai-chat-eval/contracts";

import { api, getErrorMessage } from "./api/client";
import { DiagnosisWorkspace } from "./components/DiagnosisWorkspace";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { PromptWorkspace } from "./components/PromptWorkspace";
import { EmptyState } from "./components/StatusViews";

export type ActiveView = "catalog" | "diagnosis";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeView, setActiveView] = useState<ActiveView>("catalog");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void api
      .listProjects(controller.signal)
      .then((items) => {
        setProjects(items);
        setSelectedProjectId((current) =>
          current && items.some((project) => project.id === current)
            ? current
            : (items[0]?.id ?? null),
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
  }, [reloadKey]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const handleCreateProject = useCallback(async (input: CreateProject) => {
    const created = await api.createProject(input);
    setProjects((current) => [...current, created]);
    setSelectedProjectId(created.id);
    setActiveView("catalog");
  }, []);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setActiveView("catalog");
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
        {activeView === "diagnosis" ? (
          <DiagnosisWorkspace />
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
