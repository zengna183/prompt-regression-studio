# 本地启动指南

这份指南面向第一次接触项目的使用者。完成后可以在浏览器中管理 Prompt、上传示例评测包、运行诊断，并重新打开已经保存的报告。

## 1. 准备软件

- Node.js 22 或更高版本：运行网页和服务端；
- pnpm 11.19：安装 JavaScript/TypeScript 依赖；
- Python 3.12 或更高版本：运行诊断核心；
- Docker Desktop：本地启动 PostgreSQL（数据库）和 Redis（任务队列）。

Windows 第一次安装 Docker 前，需要以管理员身份运行 `pnpm windows:enable-wsl` 启用 WSL 和虚拟机平台，然后按系统提示重启。这项操作只需执行一次。

如果只想体验命令行诊断，不需要 Docker、Node.js 或 Redis，直接按照根目录 README 的“五分钟运行第一条诊断链路”操作即可。

## 2. 用 VS Code 打开项目

在 VS Code 选择“文件 → 打开文件夹”，打开仓库根目录。VS Code 会推荐安装本项目需要的 Python、代码检查、格式化和 Docker 扩展。

Windows 用户可以按 `Ctrl+Shift+P`，输入“运行任务”，然后按编号执行：

1. `01 · 检查开发环境`：只检查，不修改电脑；
2. `02 · 安装项目依赖`：安装 Node 依赖并创建项目自己的 Python 环境；
3. `03 · 启动数据库并初始化`：启动 PostgreSQL/Redis，执行迁移并加入入门数据；
4. `04 · 启动开发环境`：同时启动网页、API 和后台 Worker；
5. `05 · 运行全部检查`：执行格式、代码检查、类型检查、测试和正式构建。

这些任务只是常用命令的中文入口；熟悉终端的开发者仍可直接运行下面的命令。

## 3. 创建本地配置

Windows PowerShell：

```powershell
pnpm setup:local
```

macOS / Linux：

```bash
cp .env.example .env
```

Windows 初始化脚本会创建 `.venv`、安装仓库内三个 Python 包，并在缺少 `.env` 时生成本地配置。示例配置只适合本机开发。准备公开部署前，必须更换数据库密码和 `MODEL_ENCRYPTION_KEY`，并按安全文档配置密钥管理。

## 4. 安装并初始化

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

Windows 用户也可以在 Docker Desktop 已启动后直接运行：

```powershell
pnpm local:init
```

`db:migrate` 会按照仓库内版本化 SQL 创建数据库结构；`db:seed` 会加入可删除的入门数据。

## 5. 启动平台

```bash
pnpm dev
```

打开：

- 网页：<http://localhost:5173>
- API 文档：<http://localhost:4000/docs>

进入左侧“回归诊断”，上传：

```text
examples/missing-information-regression/regression-bundle.json
```

运行成功后，页面会显示回归用例、Prompt 区段变化、失败分组、根因假设和消融证据。报告同时写入 PostgreSQL，并出现在“最近诊断”中。

## 登录与团队开通

默认 `AUTH_MODE=legacy` 用于本机或旧部署：共享凭证可以访问整个部署，不区分个人。多人试用请使用 `team` 模式；两种模式不会同时接受同一套凭证。

1. 先备份旧数据并运行 `pnpm db:migrate`，不要删除数据库重新初始化。
2. 由部署负责人创建第一个管理员。下面的 PowerShell 示例通过隐藏输入读取密码，不把真实密码写进命令历史或 `.env`：

```powershell
$env:AUTH_BOOTSTRAP_EMAIL = Read-Host '管理员邮箱'
$env:AUTH_BOOTSTRAP_NAME = Read-Host '管理员姓名'
$taskSecret = Read-Host '管理员密码（15～128 个字符）' -AsSecureString
try {
    $env:AUTH_BOOTSTRAP_PASSWORD = [System.Net.NetworkCredential]::new('', $taskSecret).Password
    pnpm auth:bootstrap
    if ($LASTEXITCODE -ne 0) { throw '初始化失败，请根据提示检查；不要继续切换模式。' }
} finally {
    Remove-Item Env:AUTH_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
    $taskSecret.Dispose()
}
```

macOS/Linux 可用 `read -r` 读取邮箱、`read -rs` 隐藏读取密码，再将 `AUTH_BOOTSTRAP_EMAIL`、`AUTH_BOOTSTRAP_PASSWORD` 导出到当前进程环境并运行 `pnpm auth:bootstrap`；完成后 `unset AUTH_BOOTSTRAP_PASSWORD`。部署平台应通过 Secret Manager 注入，不在命令行参数里填写密码。

旧项目不会自动分给新账号。如果确认旧部署的全部项目均应交给这位首任管理员，可在**第一次初始化前**显式设置 `AUTH_BOOTSTRAP_CLAIM_EXISTING_PROJECTS=true`；初始化后移除该变量。不设置时旧数据保留，但团队模式下不可见。这不是数据丢失，也不要通过切回 `legacy` 对外开放来绕过权限。已有账号时初始化命令会拒绝覆盖；未认领项目的后续迁移目前需要部署负责人另行安排。

3. 在 `.env` 把 `AUTH_MODE` 改为 `team`，重启 API 和网页。网页将显示个人登录；旧 `API_AUTH_TOKEN` 不能用于团队模式。
4. 管理员在“账号与成员”创建普通账号，通过安全渠道交付初始密码，提醒用户登录后修改。项目负责人再按邮箱将账号加入项目，选择负责人、编辑者或只读成员。创建账号不会自动获得所有项目权限，平台管理员也没有项目数据旁路。

会话保存在服务端，网页令牌仅在内存里保留；刷新需重新登录，最长有效期 12 小时。修改密码、停用账号会撤销旧会话。最后一位有效平台管理员不能被停用，项目最后一位有效负责人不能被移除或降级。成员移除不自动取消已经提交的实验。当前没有公开注册、邮件邀请、SSO（企业统一登录）或 MFA（多重验证）。

### 忘记密码

请联系拥有部署和数据库访问权限的人；普通项目负责人没有账号恢复权限。部署负责人运行：

```powershell
$env:AUTH_RECOVERY_EMAIL = Read-Host '需要恢复的账号邮箱'
$env:AUTH_RECOVERY_CONFIRM_EMAIL = Read-Host '再次输入同一邮箱，确认目标'
$taskSecret = Read-Host '新临时密码（15～128 个字符）' -AsSecureString
try {
    $env:AUTH_RECOVERY_PASSWORD = [System.Net.NetworkCredential]::new('', $taskSecret).Password
    pnpm auth:reset-password
    if ($LASTEXITCODE -ne 0) { throw '恢复失败，请根据提示检查。' }
} finally {
    Remove-Item Env:AUTH_RECOVERY_PASSWORD -ErrorAction SilentlyContinue
    $taskSecret.Dispose()
}
```

macOS/Linux 和部署平台同样通过环境变量提供这三个值，并在执行后移除密码变量。命令只重置指定有效账号的密码并撤销全部旧会话，不创建账号、不恢复停用账号、不更改角色；操作写入审计事件且不记录密码。通过安全渠道交付临时密码，并请用户登录后修改。不要直接改数据库里的密码哈希，也不要开放匿名 HTTP 密码重置接口。

## 6. 常见问题

### 页面提示无法连接 API

确认运行 `pnpm dev` 的终端没有退出，并检查：

- API：`http://localhost:4000/health/live` 返回 `{"status":"ok"}`；
- Worker：`http://localhost:4101/health/ready` 返回包含 `"status":"ok"` 的结果。

### 最近诊断提示数据库不可用

依次运行：

```bash
docker compose up -d
pnpm db:migrate
```

诊断核心仍可独立运行，但没有数据库时不能保存网页历史。

### Python Core 无法启动

Windows 用户先运行 `pnpm setup:local`，然后确认 `.venv\Scripts\python.exe --version` 为 3.12 或更高版本。再检查 `.env` 中的 `DIAGNOSIS_PYTHONPATH` 没有被删除。

### 如何快速检查缺少什么

Windows PowerShell：

```powershell
pnpm env:check
```

输出中的 `[ready]` 表示已经可用，`[missing]` 表示仍需安装或启动。这个检查不会修改电脑。

### 如何停止

在运行 `pnpm dev` 的终端按 `Ctrl+C`，然后运行：

```bash
docker compose down
```

不要加 `-v`；带 `-v` 会删除本地数据库卷和其中的记录。
