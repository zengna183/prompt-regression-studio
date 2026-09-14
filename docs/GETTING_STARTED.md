# 本地启动指南

这份指南面向第一次接触项目的使用者。完成后可以在浏览器中管理 Prompt、上传示例评测包、运行诊断，并重新打开已经保存的报告。

## 1. 准备软件

- Node.js 22 或更高版本：运行网页和服务端；
- pnpm 11.19：安装 JavaScript/TypeScript 依赖；
- Python 3.12 或更高版本：运行诊断核心；
- Docker Desktop：本地启动 PostgreSQL（数据库）和 Redis（任务队列）。

如果只想体验命令行诊断，不需要 Docker、Node.js 或 Redis，直接按照根目录 README 的“五分钟运行第一条诊断链路”操作即可。

## 2. 用 VS Code 打开项目

在 VS Code 选择“文件 → 打开文件夹”，打开仓库根目录。然后选择“终端 → 新建终端”，确认终端当前目录中能看到 `package.json`。

## 3. 创建本地配置

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

macOS / Linux：

```bash
cp .env.example .env
```

示例配置只适合本机开发。准备公开部署前，必须更换数据库密码和 `MODEL_ENCRYPTION_KEY`，并按安全文档配置密钥管理。

## 4. 安装并初始化

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm db:seed
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

## 6. 常见问题

### 页面提示无法连接 API

确认运行 `pnpm dev` 的终端没有退出，并检查 `http://localhost:4000/health/live` 是否返回 `{"status":"ok"}`。

### 最近诊断提示数据库不可用

依次运行：

```bash
docker compose up -d
pnpm db:migrate
```

诊断核心仍可独立运行，但没有数据库时不能保存网页历史。

### Python Core 无法启动

确认 `python --version` 为 3.12 或更高版本，并检查 `.env` 中的 `DIAGNOSIS_PYTHONPATH` 没有被删除。

### 如何停止

在运行 `pnpm dev` 的终端按 `Ctrl+C`，然后运行：

```bash
docker compose down
```

不要加 `-v`；带 `-v` 会删除本地数据库卷和其中的记录。
