# ADR 0007：Server 通过受限子进程调用 Python Core

- 状态：Accepted
- 日期：2026-09-14

## 背景

诊断算法的参考实现属于 Python Stable Core，现有产品层使用 TypeScript、Fastify 和 React。Server 需要调用 Core，但不能把诊断规则在 TypeScript 中再实现一遍，也不能让 HTTP 请求决定服务器执行什么命令。

## 决定

当前模块化单体使用独立子进程适配器：Fastify 把 Canonical Regression Bundle 作为 JSON 通过标准输入交给固定的 `python -m prompt_regression_core diagnose - --compact`，再从标准输出读取 Diagnosis Report。

以下内容只能由部署者在进程启动时配置，不能由单次请求控制：

- Python 可执行文件；
- Core 模块启动参数；
- 工作目录和明确传入的环境变量；
- 超时、输入/输出/错误输出大小上限；
- API 同时运行的诊断数量。

适配器始终关闭 shell，支持请求取消，并把 Python 错误转换为稳定、安全的公开错误码。标准错误只允许进入受信任的运维日志，不能放进 HTTP 响应。

## 为什么这样做

- Core 和 Server 可以独立发布与测试，依赖方向保持清晰；
- 标准输入/输出使用已有版本化 JSON 合同，不引入第二套 RPC 类型；
- Python 崩溃、超时或输出过大不会直接破坏 Node 主进程；
- 比在 Node 中复制算法更容易保证 CLI 与 Server 产生相同结果；
- 比立即拆出远程微服务简单，适合当前阶段的单机自托管。

## 被否决的方案

- **在 TypeScript 中重写诊断算法**：会出现两套回归与证据语义，长期必然漂移。
- **把 Python 嵌入 Node 进程**：部署和崩溃隔离更复杂，且插件/解释器状态会污染 Server 生命周期。
- **现在就建立远程 Diagnosis 微服务**：在没有独立扩容和团队所有权需求前增加网络、鉴权、部署和故障模式，收益不足。
- **允许请求传入 executable 或命令参数**：形成直接的命令执行安全风险。

## 后果

- 每次同步请求都有启动 Python 的固定开销；API 必须限制并发，不能直接暴露为无限制公共接口。
- 生产阶段的长任务应进入 BullMQ Worker，并使用幂等键、持久化状态和可恢复执行；届时仍可复用同一进程适配器。
- 部署镜像必须同时包含兼容版本的 Node 与 Python 包，并在 CI 中运行真实 HTTP → Node → Python 烟测。
- 未来若实测需要独立扩容，可以把同一 JSON 合同搬到远程服务边界，而无需改变 Core 领域语义。
