import { useEffect, useRef, useState, type FormEvent } from "react";
import { App } from "../App";
import {
  api,
  ApiError,
  getErrorMessage,
  onSessionExpired,
  setApiToken,
  type AccountIdentity,
} from "../api/client";
import { ErrorState, LoadingState } from "./StatusViews";

export function SessionGate() {
  const [mode, setMode] = useState<"team" | "legacy" | null>(null);
  const [account, setAccount] = useState<AccountIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutInFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void api
      .authStatus(controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return;
        if (status.mode !== "team" && status.mode !== "legacy")
          throw new Error("服务端未返回有效的登录模式，请检查部署版本。");
        setMode(status.mode);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(getErrorMessage(caught));
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (mode !== "team") return;
    onSessionExpired(() => {
      setApiToken("");
      setAccount(null);
      setNotice("登录已失效，请重新登录。");
    });
    return () => onSessionExpired(undefined);
  }, [mode]);
  async function logout() {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    setLoggingOut(true);
    // Capture the request token before removing all sensitive page state immediately.
    const revoke = api.logout();
    setApiToken("");
    setAccount(null);
    try {
      await revoke;
      setNotice("已退出登录。");
    } catch (caught) {
      setNotice(
        caught instanceof ApiError && caught.status === 401
          ? "会话已失效，请重新登录。"
          : "已清除本页登录信息，但服务连接失败，未确认远端会话撤销；会话最迟在登录 12 小时后失效。",
      );
    } finally {
      logoutInFlight.current = false;
      setLoggingOut(false);
    }
  }
  if (error)
    return (
      <main className="workspace">
        <ErrorState message={error} onRetry={() => setRevision((value) => value + 1)} />
      </main>
    );
  if (!mode || loggingOut)
    return (
      <main className="workspace">
        <LoadingState label="正在连接评测服务" />
      </main>
    );
  if (mode === "legacy") return <App />;
  if (account) return <App key={account.id} account={account} onLogout={() => void logout()} />;
  return (
    <LoginForm
      notice={notice}
      onSignedIn={(user, token) => {
        setApiToken(token);
        setAccount(user);
        setNotice("");
      }}
    />
  );
}

export function LoginForm({
  notice,
  onSignedIn,
}: {
  notice: string;
  onSignedIn: (user: AccountIdentity, token: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);
      onSignedIn(result.user, result.token);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <form className="flow-card flow-form" onSubmit={(event) => void login(event)}>
        <h1>登录衡鉴评测平台</h1>
        <p>使用管理员为你创建的账号登录。登录后只显示你加入的项目。</p>
        {notice && <p role="status">{notice}</p>}
        <label>
          邮箱
          <input
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          密码
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "正在登录…" : "登录"}
        </button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <small>
          登录令牌仅保存在当前页面内存中，刷新后需要重新登录。忘记密码请联系部署管理员；当前不提供公开注册。
        </small>
      </form>
    </main>
  );
}
