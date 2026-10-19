import { useCallback, useId, useState, type FormEvent } from "react";
import type { Project } from "@ai-chat-eval/contracts";
import { api, ApiError, getErrorMessage, type ModelConnection } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";
import { useProjectAccess } from "./ProjectAccess";

export function ModelWorkspace({ project }: { project: Project }) {
  const formId = useId();
  const { canManage } = useProjectAccess();
  const resource = useResource(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          return await api.listModelConnections(project.id, signal);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404)
            throw new Error(
              "当前服务器尚未启用模型连接管理。请管理员设置密钥加密配置并重启服务；已有的服务器默认模型仍可使用。",
              { cause: error },
            );
          throw error;
        }
      },
      [project.id],
    ),
  );
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [secret, setSecret] = useState("");
  const [supportsSeed, setSupportsSeed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !canManage) return;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await api.createModelConnection(project.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: secret,
        allowedModels: [...new Set(models.split(/[\s,，]+/u).filter(Boolean))],
        supportsSeed,
      });
      setName("");
      setModels("");
      setBaseUrl("");
      setMessage("连接已保存，可以在实验或 AI 用例生成中选择它。");
      resource.reload();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSecret("");
      setBusy(false);
    }
  }
  return (
    <main className="workspace flow-workspace">
      <header className="workspace-header">
        <div>
          <div className="breadcrumb">{project.name} / 模型连接</div>
          <h1>连接你要评测的模型</h1>
          <p>支持兼容 OpenAI 对话接口的服务。生成回答和评分可以使用不同的模型。</p>
        </div>
      </header>
      {resource.loading && <LoadingState />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && (
        <>
          {canManage && (
            <form className="flow-card flow-form" onSubmit={(event) => void create(event)}>
              <h2>添加模型连接</h2>
              <label>
                连接名称
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：团队模型服务"
                  disabled={busy}
                />
              </label>
              <label htmlFor={`${formId}-url`}>服务地址</label>
              <input
                id={`${formId}-url`}
                aria-describedby={`${formId}-url-help`}
                required
                type="url"
                maxLength={2048}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://你的模型服务地址/v1"
                disabled={busy}
              />
              <small id={`${formId}-url-help`}>
                由模型供应商提供的基础地址，不要填写完整的对话请求路径。
              </small>
              <label htmlFor={`${formId}-secret`}>API Key（供应商提供的调用密钥）</label>
              <input
                id={`${formId}-secret`}
                aria-describedby={`${formId}-secret-help`}
                required
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={512}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={busy}
              />
              <small id={`${formId}-secret-help`}>
                仅用于提交，保存后不会回显；不会存入浏览器的本地存储。
              </small>
              <label>
                可用模型名称
                <textarea
                  required
                  maxLength={12050}
                  value={models}
                  onChange={(e) => setModels(e.target.value)}
                  placeholder="填写供应商的准确模型名称，多个模型用换行或逗号分隔"
                  disabled={busy}
                />
              </label>
              <label className="flow-check">
                <input
                  type="checkbox"
                  checked={supportsSeed}
                  onChange={(e) => setSupportsSeed(e.target.checked)}
                  disabled={busy}
                />
                服务支持随机种子（帮助重复评测保持一致；不支持时取消）
              </label>
              <button className="button button--primary" disabled={busy} type="submit">
                {busy ? "正在保存…" : "保存连接"}
              </button>
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              {message && <p role="status">{message}</p>}
            </form>
          )}
          {!canManage && <p>仅项目负责人可以添加、测试、停用模型连接或更换密钥。</p>}
          <section className="flow-stack" aria-label="已保存的连接">
            <h2>已保存的连接</h2>
            {resource.data.length === 0 && (
              <p>还没有连接。完成上面的设置后，就可以选择模型开始评测。</p>
            )}
            {resource.data.map((connection) => (
              <ConnectionCard
                key={`${connection.id}-${connection.updatedAt}`}
                connection={connection}
                onChanged={resource.reload}
              />
            ))}
          </section>
        </>
      )}
    </main>
  );
}

function ConnectionCard({
  connection,
  onChanged,
}: {
  connection: ModelConnection;
  onChanged: () => void;
}) {
  const { canManage } = useProjectAccess();
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function act(kind: "test" | "rotate" | "disable") {
    if (busy || !canManage) return;
    setBusy(true);
    setMessage("");
    setError(null);
    try {
      if (kind === "test") {
        const result = await api.testModelConnection(connection.projectId, connection.id);
        if (!result.reachable)
          throw new Error(
            result.code === "PROVIDER_AUTHENTICATION_FAILED"
              ? "供应商拒绝了密钥，请检查后更换。"
              : "连接测试未通过，请检查地址、模型名称或供应商状态。错误编号：" + result.code,
          );
        setMessage("连接正常，模型已成功返回回答。");
      } else if (kind === "rotate") {
        await api.rotateModelKey(connection.projectId, connection.id, secret);
        onChanged();
      } else {
        await api.disableModelConnection(connection.projectId, connection.id);
        onChanged();
      }
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSecret("");
      setBusy(false);
    }
  }
  return (
    <article className="flow-card flow-stack">
      <h3>
        {connection.name}{" "}
        <span className="flow-badge">{connection.disabledAt ? "已停用" : "可用"}</span>
      </h3>
      <p className="flow-wrap">{connection.baseUrl}</p>
      <p>模型：{connection.allowedModels.join("、")}</p>
      {!connection.disabledAt && canManage && (
        <>
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={() => void act("test")}
          >
            测试连接（会产生少量模型调用）
          </button>
          <details>
            <summary>更换密钥</summary>
            <form
              className="flow-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act("rotate");
              }}
            >
              <label>
                新密钥
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={512}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  disabled={busy}
                />
              </label>
              <button className="button button--secondary" disabled={busy}>
                保存新密钥
              </button>
            </form>
          </details>
          <details>
            <summary>停用连接</summary>
            <p>停用后不能再用于新调用；已经发出的请求可能仍会完成。需要恢复时请新建连接。</p>
            <label className="flow-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              确认停用这个连接
            </label>
            <button
              className="button button--secondary"
              disabled={!confirmed || busy}
              onClick={() => void act("disable")}
            >
              确认停用
            </button>
          </details>
        </>
      )}
      {busy && <p role="status">正在处理…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </article>
  );
}
