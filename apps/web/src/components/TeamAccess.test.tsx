// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DatasetVersion, Project } from "@ai-chat-eval/contracts";
import { api, onSessionExpired, setApiToken } from "../api/client";
import { LoginForm, SessionGate } from "./SessionGate";
import { PasswordForm, TeamWorkspace } from "./TeamWorkspace";
import { ProjectAccess } from "./ProjectAccess";
import { ModelWorkspace } from "./ModelWorkspace";
import { ExperimentWorkspace } from "./ExperimentWorkspace";
import { DatasetReview } from "./DatasetReview";

const now = "2026-10-17T00:00:00.000Z";
const account = { id: "user", email: "member@example.test", displayName: "林", isAdmin: false };
const project: Project = {
  id: "project",
  name: "私有项目",
  slug: "private",
  description: null,
  createdAt: now,
  updatedAt: now,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pathOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
function network(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi
    .fn<typeof fetch>()
    .mockImplementation((input, init) => Promise.resolve(handler(pathOf(input), init)));
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function signIn() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("邮箱"), account.email);
  await user.type(screen.getByLabelText("密码"), "test-only long password");
  await user.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByRole("button", { name: `${account.displayName} · 退出登录` });
  return user;
}
afterEach(() => {
  cleanup();
  onSessionExpired(undefined);
  setApiToken("");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("个人登录与权限界面（真实组件，模拟网络边界）", () => {
  it("模式探测失败时不会降级为无账号工作台，也不会读取私有项目", async () => {
    const fetchMock = network(() => json({ mode: "unknown" }));
    render(<SessionGate />);
    expect((await screen.findByRole("alert")).textContent).toContain("有效的登录模式");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("从一个评测项目开始")).toBeNull();
  });
  it("登录失败后清空密码，不将密码或令牌写入浏览器存储", async () => {
    const signedIn = vi.fn();
    const store = vi.spyOn(Storage.prototype, "setItem");
    network(() => json({ code: "INVALID_CREDENTIALS" }, 401));
    const user = userEvent.setup();
    render(<LoginForm notice="" onSignedIn={signedIn} />);
    await user.type(screen.getByLabelText("邮箱"), account.email);
    await user.type(screen.getByLabelText("密码"), "wrong password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText<HTMLInputElement>("密码").value).toBe("");
    expect(signedIn).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
  it("登录后只带内存会话访问项目，会话过期后卸载工作台", async () => {
    let expired = false;
    const fetchMock = network((path) =>
      path.endsWith("/auth/status")
        ? json({ mode: "team" })
        : path.endsWith("/auth/login")
          ? json({ user: account, token: "private-token", expiresAt: now })
          : expired
            ? json({ code: "UNAUTHORIZED" }, 401)
            : json([]),
    );
    render(<SessionGate />);
    await signIn();
    await screen.findByText("从一个评测项目开始");
    const request = fetchMock.mock.calls.find(([input]) => pathOf(input).endsWith("/v1/projects"));
    expect(new Headers(request?.[1]?.headers).get("Authorization")).toBe("Bearer private-token");
    expired = true;
    await act(async () => {
      await expect(api.listProjects()).rejects.toMatchObject({ status: 401 });
    });
    await screen.findByText("登录已失效，请重新登录。");
    expect(screen.queryByText("从一个评测项目开始")).toBeNull();
  });
  it("退出时立即移除工作台，远端撤销请求仍携带原会话", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = network((path) =>
      path.endsWith("/auth/status")
        ? json({ mode: "team" })
        : path.endsWith("/auth/login")
          ? json({ user: account, token: "private-token", expiresAt: now })
          : path.endsWith("/auth/logout")
            ? new Promise<Response>((resolve) => {
                finish = resolve;
              })
            : json([]),
    );
    render(<SessionGate />);
    const user = await signIn();
    await user.click(screen.getByRole("button", { name: `${account.displayName} · 退出登录` }));
    expect(screen.queryByRole("button", { name: `${account.displayName} · 退出登录` })).toBeNull();
    const request = fetchMock.mock.calls.find(([input]) => pathOf(input).endsWith("/auth/logout"));
    expect(new Headers(request?.[1]?.headers).get("Authorization")).toBe("Bearer private-token");
    act(() => {
      finish?.(json({ ok: true }));
    });
    await screen.findByText("已退出登录。");
    await api.listProjects();
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).has("Authorization")).toBe(false);
  });
  it("密码确认不一致不发送请求，修改成功要求重新登录并清空表单", async () => {
    const fetchMock = network(() => json({ ok: true }));
    const changed = vi.fn();
    const user = userEvent.setup();
    render(<PasswordForm onChanged={changed} />);
    await user.click(screen.getByText("修改我的密码"));
    fireEvent.change(screen.getByLabelText("当前密码"), {
      target: { value: "old-test-only-password" },
    });
    fireEvent.change(screen.getByLabelText("新密码"), {
      target: { value: "new-test-only-password" },
    });
    fireEvent.change(screen.getByLabelText("再次填写新密码"), {
      target: { value: "different-test-password" },
    });
    await user.click(screen.getByRole("button", { name: "修改密码并重新登录" }));
    expect((await screen.findByRole("alert")).textContent).toContain("不一致");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("再次填写新密码"), {
      target: { value: "new-test-only-password" },
    });
    await user.click(screen.getByRole("button", { name: "修改密码并重新登录" }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText<HTMLInputElement>("新密码").value).toBe("");
  });
  it.each(["editor", "viewer"])("%s 可以看模型信息但不能添加、测试或更换密钥", async (role) => {
    network((path) =>
      path.endsWith("/access")
        ? json({ role })
        : json([
            {
              id: "connection",
              projectId: project.id,
              name: "现有连接",
              baseUrl: "https://example.test/v1",
              allowedModels: ["test"],
              supportsSeed: true,
              disabledAt: null,
              createdAt: now,
              updatedAt: now,
            },
          ]),
    );
    render(
      <ProjectAccess enabled projectId={project.id}>
        <ModelWorkspace project={project} />
      </ProjectAccess>,
    );
    await screen.findByText("现有连接");
    expect(screen.queryByRole("button", { name: "保存连接" })).toBeNull();
    expect(screen.queryByText("更换密钥")).toBeNull();
    expect(screen.queryByRole("button", { name: /测试连接/ })).toBeNull();
  });
  it("只读成员可以浏览实验列表，但不能创建实验", async () => {
    network((path) => (path.endsWith("/access") ? json({ role: "viewer" }) : json([])));
    render(
      <ProjectAccess enabled projectId={project.id}>
        <ExperimentWorkspace project={project} />
      </ProjectAccess>,
    );
    expect(
      (await screen.findByRole<HTMLButtonElement>("button", { name: "新建实验" })).disabled,
    ).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>("历史实验").disabled).toBe(false);
    expect(screen.queryByLabelText("实验名称")).toBeNull();
  });
  it("负责人按邮箱添加成员，移除需要再次确认并通知刷新权限", async () => {
    const writes: unknown[] = [];
    const changed = vi.fn();
    network((path, init) => {
      if (init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        writes.push(JSON.parse(init.body));
        return json({ ok: true });
      }
      return path.endsWith("/access")
        ? json({ role: "owner" })
        : json([
            {
              userId: "other",
              displayName: "小周",
              email: "other@example.test",
              role: "viewer",
              disabledAt: null,
            },
          ]);
    });
    const user = userEvent.setup();
    render(
      <TeamWorkspace
        project={project}
        account={account}
        onLogout={() => {}}
        onMembershipChanged={changed}
      />,
    );
    await user.type(await screen.findByLabelText("成员邮箱"), "editor@example.test");
    await user.selectOptions(screen.getByLabelText("成员权限"), "editor");
    await user.click(screen.getByRole("button", { name: "添加成员" }));
    await waitFor(() => expect(writes).toEqual([{ email: "editor@example.test", role: "editor" }]));
    await user.click(await screen.findByRole("button", { name: "移除成员" }));
    expect(writes).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "确认修改成员" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ userId: "other", role: null });
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("登录模式审核人不可自填，单字姓名也能提交并由服务器确认身份", async () => {
    const writes: Record<string, unknown>[] = [];
    const version: DatasetVersion = {
      id: "version",
      datasetId: "dataset",
      version: 1,
      status: "draft",
      source: "manual",
      contentHash: "a".repeat(64),
      caseCount: 1,
      generationProvenance: null,
      parentVersionId: null,
      changeSummary: null,
      createdAt: now,
      publishedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewNotes: null,
    };
    network((path, init) => {
      if (init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        writes.push(JSON.parse(init.body) as Record<string, unknown>);
        return json({ ...version, reviewedAt: now });
      }
      return path.endsWith("/access")
        ? json({ role: "editor" })
        : json([{ caseKey: "one", input: "你好", metadata: {} }]);
    });
    const user = userEvent.setup();
    render(
      <ProjectAccess enabled projectId={project.id} reviewerName="林">
        <DatasetReview version={version} onChanged={() => {}} />
      </ProjectAccess>,
    );
    await user.click(await screen.findByLabelText("我已核对这条用例和参考回答"));
    expect(screen.queryByLabelText(/审核人/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "确认审核并保存" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.reviewerName).toBe("林（登录账号）");
  });
});
