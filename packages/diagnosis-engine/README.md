# `@prompt-regression/diagnosis-engine`

受控地从 Node.js 调用 Python 诊断 Core。这个包是应用层与 Python Core 之间的端口适配器，不包含诊断算法，也不依赖数据库、队列或 Web 框架。

## 安全边界

- 进程始终使用 `shell: false` 启动。
- 可执行文件和模块参数只在进程启动时由部署者配置；单次 `diagnose` 调用不能传入命令或参数。
- 固定追加 `diagnose - --compact`，评测包通过标准输入传入，报告从标准输出读取。
- 输入、输出和标准错误均有独立字节上限，并支持超时与 `AbortSignal` 取消。
- 面向调用方的错误消息不会包含 Python 的标准错误；受限的诊断文本只能通过明确命名的运维接口读取。

默认环境策略是 `minimal`：仅从父进程保留启动解释器通常必需的 `PATH`、Windows 系统变量、临时目录和区域设置变量，然后叠加部署者显式提供的变量。它有意不继承 `PYTHONPATH`、云凭证、数据库口令等变量。开发环境若需要 `PYTHONPATH`，应通过 `environment` 显式传入。

`inherit` 策略适用于完全受信的单机部署，但会把父进程中的所有环境变量交给 Python 子进程，应谨慎使用。

```ts
import { PythonProcessDiagnosisEngine } from "@prompt-regression/diagnosis-engine";

const engine = new PythonProcessDiagnosisEngine({
  executable: "/opt/prompt-regression/venv/bin/python",
  moduleArgs: ["-m", "prompt_regression_core"],
  environment: { PYTHONUNBUFFERED: "1" },
});

const report = await engine.diagnose(bundle, { signal });
```

`diagnose` 的输入类型刻意设为 `unknown`，所以 Fastify 路由可直接传入未经信任的
`request.body`；适配器会在启动 Python 前验证它必须是 JSON 对象：

```ts
app.post("/v1/diagnoses", async (request) => engine.diagnose(request.body));
```
