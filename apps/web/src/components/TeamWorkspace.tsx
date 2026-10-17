import { useCallback, useState, type FormEvent } from "react";
import type { Project } from "@ai-chat-eval/contracts";
import { api, getErrorMessage, type AccountIdentity, type ProjectRole } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";

const labels = { owner: "负责人", editor: "编辑者", viewer: "只读成员" };
export function TeamWorkspace({
  project,
  account,
  onLogout,
  onMembershipChanged,
}: {
  project: Project | null;
  account: AccountIdentity;
  onLogout: () => void;
  onMembershipChanged?: () => void;
}) {
  return (
    <main className="workspace flow-workspace">
      <header className="workspace-header">
        <div>
          <h1>账号与项目成员</h1>
          <p>
            当前账号：{account.displayName}（{account.email}）
          </p>
          <p>负责人管理成员和模型密钥；编辑者维护评测内容并启动实验；只读成员查看结果。</p>
        </div>
      </header>
      <PasswordForm onChanged={onLogout} />
      {project ? (
        <ProjectMembers key={project.id} project={project} onChanged={onMembershipChanged} />
      ) : (
        <p>请选择或创建项目后管理成员。</p>
      )}
      {account.isAdmin && <AccountAdmin />}
    </main>
  );
}
export function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (next !== confirmation) {
      setError("两次填写的新密码不一致。");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setCurrent("");
      setNext("");
      setConfirmation("");
      setBusy(false);
    }
  }
  return (
    <details className="flow-card">
      <summary>修改我的密码</summary>
      <form className="flow-form" onSubmit={(event) => void save(event)}>
        <p>修改后会撤销所有设备上的旧登录，需要重新登录。密码至少 15 个字符，支持中文和空格。</p>
        <fieldset disabled={busy} className="flow-form">
          <label>
            当前密码
            <input
              type="password"
              required
              autoComplete="current-password"
              maxLength={128}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={15}
              maxLength={128}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label>
            再次填写新密码
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={15}
              maxLength={128}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <button className="button button--primary">修改密码并重新登录</button>
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
function ProjectMembers({
  project,
  onChanged,
}: {
  project: Project;
  onChanged?: (() => void) | undefined;
}) {
  const resource = useResource(
    useCallback(
      async (signal: AbortSignal) => {
        const [access, members] = await Promise.all([
          api.projectAccess(project.id, signal),
          api.listMembers(project.id, signal),
        ]);
        return { access, members };
      },
      [project.id],
    ),
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    userId: string;
    role: ProjectRole | null;
    name: string;
  } | null>(null);
  async function update(
    input: { email: string; role: ProjectRole } | { userId: string; role: ProjectRole | null },
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.setMember(project.id, input);
      setEmail("");
      setPending(null);
      resource.reload();
      onChanged?.();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flow-card flow-stack">
      <h2>{project.name} · 项目成员</h2>
      {resource.loading && <LoadingState />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && (
        <>
          <p>你在本项目的身份：{labels[resource.data.access.role]}</p>
          {resource.data.access.role === "owner" && (
            <form
              className="flow-form"
              onSubmit={(e) => {
                e.preventDefault();
                void update({ email: email.trim(), role });
              }}
            >
              <h3>添加已注册成员</h3>
              <p>
                填写对方的账号邮箱。没有账号时，请平台管理员先在下方创建账号；不会发送邮件邀请。
              </p>
              <label>
                成员邮箱
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  disabled={busy}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                成员权限
                <select
                  value={role}
                  disabled={busy}
                  onChange={(e) => setRole(e.target.value as ProjectRole)}
                >
                  {Object.entries(labels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button button--primary" disabled={busy}>
                添加成员
              </button>
            </form>
          )}
          <ul className="flow-stack">
            {resource.data.members.map((member) => (
              <li key={member.userId}>
                {member.displayName} · {member.email} · {labels[member.role]}
                {member.disabledAt && "（账号已停用）"}
                {resource.data?.access.role === "owner" && (
                  <div className="flow-actions">
                    <label>
                      调整 {member.displayName} 的权限
                      <select
                        value={member.role}
                        disabled={busy || Boolean(member.disabledAt)}
                        onChange={(e) =>
                          setPending({
                            userId: member.userId,
                            role: e.target.value as ProjectRole,
                            name: member.displayName,
                          })
                        }
                      >
                        {Object.entries(labels).map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={() =>
                        setPending({ userId: member.userId, role: null, name: member.displayName })
                      }
                    >
                      移除成员
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {pending && (
            <div role="alert" className="flow-card">
              <p>
                确认{pending.role === null ? "移除" : `将权限调整为${labels[pending.role]}`}：
                {pending.name}？移除后对方不能再访问该项目；已提交的实验不会自动取消。
              </p>
              <div className="flow-actions">
                <button
                  className="button button--secondary"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  返回
                </button>
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void update({ userId: pending.userId, role: pending.role })}
                >
                  确认修改成员
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
function AccountAdmin() {
  const resource = useResource(useCallback((signal: AbortSignal) => api.listUsers(signal), []));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [disable, setDisable] = useState<AccountIdentity | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await api.createUser({ email: email.trim(), displayName: name.trim(), password });
      setName("");
      setEmail("");
      setMessage(
        "账号已创建。请通过安全渠道告知对方初始密码，并提醒登录后修改；再将账号添加到相应项目。",
      );
      resource.reload();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  async function deactivate() {
    if (!disable || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.disableUser(disable.id);
      setDisable(null);
      resource.reload();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flow-card flow-stack">
      <h2>平台账号管理（管理员）</h2>
      <p>创建账号不等于加入所有项目；管理员也需要加入项目才能查看其中的数据。</p>
      <form className="flow-form" onSubmit={(event) => void create(event)}>
        <fieldset disabled={busy} className="flow-form">
          <label>
            姓名
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            账号邮箱
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            初始密码
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="button button--primary">创建普通账号</button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {resource.loading && <LoadingState />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      <ul>
        {resource.data?.map((user) => (
          <li key={user.id}>
            {user.displayName} · {user.email} ·{" "}
            {user.disabledAt ? "已停用" : user.isAdmin ? "管理员" : "普通账号"}
            {!user.disabledAt && (
              <button
                className="button button--quiet"
                disabled={busy}
                onClick={() => setDisable(user)}
              >
                停用账号
              </button>
            )}
          </li>
        ))}
      </ul>
      {disable && (
        <div role="alert">
          <p>
            确认停用 {disable.email}
            ？该账号将不能登录，所有现有登录会话会失效。必须先转移其负责的项目。
          </p>
          <button className="button button--quiet" disabled={busy} onClick={() => setDisable(null)}>
            返回
          </button>
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={() => void deactivate()}
          >
            确认停用账号
          </button>
        </div>
      )}
    </section>
  );
}
