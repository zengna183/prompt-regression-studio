import type { ReactNode } from "react";

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="status-card status-card--error" role="alert">
      <span className="status-card__icon" aria-hidden="true">
        !
      </span>
      <div>
        <strong>暂时无法加载</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <button className="button button--quiet" type="button" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__mark" aria-hidden="true">
        ◇
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
