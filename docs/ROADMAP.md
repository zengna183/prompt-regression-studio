# Prompt Regression Diagnosis 路线图

路线按“证据是否可信、接口是否稳定、系统是否可运营”排序，不按页面数量排序。每个阶段只有在验收测试进入仓库后才算完成。

## M0 — 可重复的诊断纵向链路（已完成）

目标：不用真实 LLM、不用数据库，也能完整证明核心领域模型和证据规则可以工作。

已完成：

- `v1alpha1` Regression Bundle 与 Diagnosis Report JSON Schema；
- 无厂商依赖的 Python Stable Core；
- Baseline/Candidate 成对退化检测；
- 确定性失败聚类、稳定片段 Diff、待验证根因假设；
- 单片段回退消融计划和显式 fixture runner；
- 目标恢复、对照损伤、最小样本三项证据门槛；
- `hypothesized / supported / rejected / inconclusive` 状态；
- CLI 的 `validate` 与 `diagnose`；
- 可重复示例、错误输入、无证据不造假和状态分支测试；
- ADR、Changelog、第三方代码来源与许可证政策。

本阶段 fixture 是输入文件中保存的测试结果，不是真实模型输出。M0 不证明算法适合生产统计决策。

退出标准：

- 相同输入在相同版本产生字节一致报告；
- 输入包和输出报告都通过 JSON Schema；
- 所有报告引用都能回到具体 case、change、hypothesis、plan、run 与 evidence；
- 缺少消融结果时假设保持 `hypothesized`，绝不生成合成证据；
- Python Core 与仍保留的 TypeScript 基础质量检查全部变绿。

## M1 — 可互操作的导入与插件合同（当前）

目标：让现有评测系统的真实结果进入诊断层，而不是重新造一套通用 Eval 编排器。

已完成：

- 版本化 Plugin Manifest、Core 版本协商、11 类能力声明和同进程信任警告；
- Promptfoo `EvaluateSummaryV3` EvalImporter，保留原始运行、断言、Provider 指纹和 Trace/Evaluation ID；
- 导入时明确拒绝执行错误、缺失/重复配对、测试合同变化、模型/Provider/评判器混杂；
- Promptfoo importer CLI、离线脱敏 fixture、插件加载测试和可构建 wheel；
- Node 应用层到 Python Core 的受限进程适配器，以及同步 HTTP 诊断入口；
- 真实 HTTP → Node → Python Core 的自动烟测入口；
- Web 本地诊断工作台：文件/粘贴导入、预检查、取消/重试和证据报告；
- PostgreSQL 初始迁移、诊断运行状态与报告持久化、历史列表和报告重新打开。

剩余：

- 实现通用 JSON/CSV importer 与逐行导入错误报告；
- 增加 DatasetBuilder 边界：支持人工录入/导入，也允许 AI 只“建议”测试用例；AI 生成用例必须记录模型与 Prompt 来源、标为 synthetic、去重并经人工审核后形成不可变 DatasetVersion；
- 实现 Langfuse API/export adapter，只使用许可兼容的公开接口；
- 实现 Phoenix/OpenInference TraceImporter，采用独立协议实现，不复制 ELv2 主仓代码；
- 明确缺失、失败、跳过、重复和部分结果的归一化语义；
- 对每个 importer/strategy 发布同一套 contract tests；
- 从 JSON Schema 生成 TypeScript 类型与客户端，避免手写两套合同；
- 发布可安装 Python wheel 和带校验和的 CLI 构建物。

退出标准：

- 三种来源的固定 golden export 可转换为同一 Canonical Bundle；
- 导入不会丢失原始 ID、模型/评测器快照、错误和证据链接；
- 不联网、无 API Key 时 contract tests 全部可运行；
- 不兼容 Schema/Core/插件版本明确失败并给出升级路径。

## M2 — 真实受控消融与统计证据

目标：用真实模型和评测器执行可恢复、可审计的干预实验。

- ProviderAdapter 与 EvaluatorAdapter 的正式生命周期；
- Provider 超时、速率限制、重试分类、幂等键、费用预算和取消；
- 模型/参数/评测器/标准/数据集全部固定并进入运行摘要；
- 随机模型的重复调用、随机/平衡运行顺序和种子记录；
- 单片段替换、删除、回退以及多因素 factorial ablation；
- Bootstrap 区间、置换检验、效应量、功效提示与多重检验修正；
- 对照组损伤、交互效应、无法识别和证据冲突的明确状态；
- 确定性 fake provider/evaluator 只存在于测试路径，生产配置无法选择。

退出标准：

- Worker 被杀死并重启后，不重复写入终态结果，也不丢失已完成项目；
- 每个支持或拒绝状态都有不可变干预运行和版本化判定规则；
- 在固定基准上发布恢复率、方差、成本和失败覆盖，而不只发布总分；
- 故障注入覆盖限流、超时、无效输出、取消和预算耗尽。

## M3 — 团队版 Server、数据库与非技术 UI

目标：把已验证的 Core 接入多人使用的平台，同时保持 CLI/API-first。

- PostgreSQL 正式加入 Regression、Cluster、Hypothesis、Ablation、Evidence、Report 表与迁移；
- 把已可用的 Fastify Bundle/process adapter 同步入口升级为持久化、幂等的诊断任务 API，不复制诊断算法；
- BullMQ Worker 执行真实评测和消融，API 请求不长时间等待；
- React 页面呈现 Prompt 版本对比、失败组、片段改动、证据状态和逐 case 下钻；
- “为什么认为有关”“做了什么实验”“支持与反对证据”同时显示；
- 评判标准、阈值和权重在后台独立版本化，历史报告不被原地改写；
- 报告 JSON/CSV 导出带输入哈希、版本和来源清单；
- 浏览器 E2E、可访问性和大数据量列表基线。

退出标准：

- 非技术用户可以导入两版真实结果并读懂诊断链路；
- 页面任何因果色彩标签都能点到消融运行和具体证据；
- 数据库升级、回滚和从空库重建在 CI 中演练；
- CLI 与 Server 对同一 Bundle 产生合同等价结果。

## M4 — 可公开自托管 Beta

目标：让外部团队可以安全升级和运营，而不是只能由作者本机运行。

- 登录、项目 RBAC、Service Account 和租户越权测试；
- 模型密钥信封加密、轮换、脱敏和 Secret 扫描；
- SSRF 防护、上传限制、Prompt/回答/Trace 的保留与删除策略；
- 用户/项目/Provider 多级限流和费用上限；
- 追加式审计日志与管理员操作追踪；
- OpenTelemetry 指标/Trace、队列告警和排障手册；
- PostgreSQL 备份恢复与灾难演练；
- 版本化 Docker 镜像/Compose、SBOM、签名和构建来源证明；
- 威胁模型、性能基准、升级兼容矩阵和安全响应流程。

Beta 门槛：

- 高危安全问题清零，自动化租户隔离测试通过；
- 上一支持版本能原地升级并有回滚说明；
- 备份恢复、滚动 Worker 停机和任务恢复有演练记录；
- 至少两个外部真实工作流无需维护者手工改数据即可完成。

## M5 — Stable 1.0

目标：给用户可预测的兼容承诺和长期维护流程。

- Core API、JSON Schema、插件 SPI 和数据库迁移的兼容政策；
- SemVer、弃用窗口、长期支持范围和自动兼容测试；
- 多个 Beta 版本的真实升级记录；
- 发布性能/成本/统计方法与限制，而非营销式指标；
- Maintainer、RFC、Review、发布签名和漏洞响应不依赖单个人；
- 没有未解决的关键数据完整性或安全问题。

## 早期明确不做

- 为了显得“成熟”而提前拆成大量微服务；
- 在 PostgreSQL 没有实测瓶颈前引入 ClickHouse；
- 在一个可靠 adapter 都没有之前同时支持所有模型厂商；
- 把相似性、LLM 解释或 Prompt Diff 直接标成根因；
- 用 Demo、随机分数或 fixture 冒充真实生产运行；
- 在证据链、升级和安全尚未完成时宣称可广泛生产使用。
