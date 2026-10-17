import { createContext, useCallback, useContext, type ReactNode } from "react";
import { api, type ProjectRole } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";
const Access = createContext<{ role: ProjectRole | null; reviewerName?: string }>({
  role: "owner",
});
export function useProjectAccess() {
  const { role, reviewerName } = useContext(Access);
  return {
    role,
    reviewerName,
    canEdit: role === "owner" || role === "editor",
    canManage: role === "owner",
  };
}
export function ProjectAccess({
  enabled,
  projectId,
  reviewerName,
  children,
}: {
  enabled: boolean;
  projectId: string | null;
  reviewerName?: string;
  children: ReactNode;
}) {
  const resource = useResource(
    useCallback(
      (signal: AbortSignal) =>
        enabled && projectId
          ? api.projectAccess(projectId, signal)
          : Promise.resolve<{ role: ProjectRole }>({ role: "owner" }),
      [enabled, projectId],
    ),
  );
  if (!enabled || !projectId) return <>{children}</>;
  if (resource.loading) return <LoadingState label="正在确认项目权限" />;
  if (resource.error) return <ErrorState message={resource.error} onRetry={resource.reload} />;
  const role = resource.data?.role ?? null;
  return (
    <Access.Provider value={{ role, ...(reviewerName ? { reviewerName } : {}) }}>
      <div className="project-access-note">
        项目权限：
        {role === "owner"
          ? "负责人，可管理成员和模型密钥"
          : role === "editor"
            ? "编辑者，可维护内容和启动评测"
            : "只读成员，可查看数据，不能修改或启动评测"}
      </div>
      {children}
    </Access.Provider>
  );
}
