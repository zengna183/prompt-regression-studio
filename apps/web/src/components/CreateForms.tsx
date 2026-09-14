import { useId, useState, type FormEvent } from "react";
import type { CreateProject, CreatePrompt } from "@ai-chat-eval/contracts";

import { getErrorMessage } from "../api/client";

interface ProjectFormProps {
  onSubmit: (input: CreateProject) => Promise<void>;
  onCancel: () => void;
}

interface PromptFormProps {
  onSubmit: (input: CreatePrompt) => Promise<void>;
  onCancel: () => void;
}

export function CreateProjectForm({ onSubmit, onCancel }: ProjectFormProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        slug: slug.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="compact-form" onSubmit={(event) => void handleSubmit(event)}>
      <h3>创建项目</h3>
      <label htmlFor={`${formId}-project-name`}>项目名称</label>
      <input
        id={`${formId}-project-name`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        minLength={2}
        maxLength={120}
        placeholder="例如：客服助手评测"
        required
        autoFocus
      />
      <label htmlFor={`${formId}-project-slug`}>英文标识</label>
      <input
        id={`${formId}-project-slug`}
        value={slug}
        onChange={(event) => setSlug(event.target.value.toLowerCase())}
        minLength={2}
        maxLength={64}
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        placeholder="customer-support"
        aria-describedby={`${formId}-project-slug-hint`}
        required
      />
      <small id={`${formId}-project-slug-hint`}>
        用于接口和链接，只能填写小写字母、数字与连字符。
      </small>
      <label htmlFor={`${formId}-project-description`}>说明（可选）</label>
      <textarea
        id={`${formId}-project-description`}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={1000}
        rows={3}
        placeholder="这个项目要评测什么？"
      />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          className="button button--quiet"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? "创建中…" : "创建项目"}
        </button>
      </div>
    </form>
  );
}

export function CreatePromptForm({ onSubmit, onCancel }: PromptFormProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        key: key.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="panel-form" onSubmit={(event) => void handleSubmit(event)}>
      <div className="panel-form__header">
        <div>
          <span className="eyebrow">NEW PROMPT</span>
          <h3>新建 Prompt</h3>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onCancel}
          aria-label="关闭新建 Prompt 表单"
        >
          ×
        </button>
      </div>
      <div className="form-grid">
        <label>
          <span>Prompt 名称</span>
          <input
            id={`${formId}-prompt-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={120}
            placeholder="例如：售后问题回答"
            required
            autoFocus
          />
        </label>
        <label>
          <span>英文标识</span>
          <input
            id={`${formId}-prompt-key`}
            value={key}
            onChange={(event) => setKey(event.target.value.toLowerCase())}
            minLength={2}
            maxLength={64}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            placeholder="after-sales-answer"
            required
          />
        </label>
      </div>
      <label>
        <span>用途说明（可选）</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="说明这个 Prompt 在什么场景下使用。"
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          className="button button--quiet"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? "创建中…" : "创建 Prompt"}
        </button>
      </div>
    </form>
  );
}
