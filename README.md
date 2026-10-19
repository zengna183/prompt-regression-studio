# Prompt Regression Studio

[English](./README.en.md) · [本地启动](./docs/GETTING_STARTED.md) · [架构设计](./docs/ARCHITECTURE.md) · [安全部署](./docs/SECURITY_DEPLOYMENT.md) · [部署与备份](./docs/OPERATIONS.md) · [数据合同](./contracts/README.md) · [架构决策](./docs/adr/) · [参与贡献](./CONTRIBUTING.md)

一个开源、证据优先的 LLM（大语言模型）Prompt（提示词）回归诊断框架。

它不只回答“哪个 Prompt 分数更高”，还要回答：候选版本是否真的变差、哪些场景变差、哪一段修改值得怀疑，以及受控实验是否支持这个怀疑。

> **项目状态：pre-alpha（公开测试前的早期阶段），不可用于生产决策。**
>
> 已有可运行的评测、诊断和段落回退链路，以及可选的个人登录、项目成员角色和接口隔离。真实服务链路、模型故障、进程崩溃、队列断网及有界并发已纳入 [系统验收](./docs/SYSTEM_TESTING.md)；受保护的监控、隔离备份恢复和生产容器已通过 [部署验收](./docs/OPERATIONS.md)。真实付费模型、浏览器全流程、实际公网环境及生产容量仍待验收。最新完成范围以 [任务清单](./TASKS.md) 为准。当前版本适合本地、内网或受控团队试用，不代表已经达到成熟 SaaS 程度。

多人使用请按[登录与团队开通](./docs/GETTING_STARTED.md#登录与团队开通)启用 `AUTH_MODE=team`。默认 `legacy` 保留旧的共享访问凭证模式，**不提供个人账号隔离**；不要把这个模式当成公开多人服务。

开发者可按[命令行与 CI 接入](./docs/CLI_AND_CI.md)使用回归门禁、插件检查与可复用 GitHub Action。网页诊断报告可下载完整 JSON、可读摘要和退化用例 CSV。

## 它和通用 Eval 平台有什么不同

Promptfoo、Langfuse、Phoenix 等项目已经很好地解决了评测执行、可观测性或实验分析的一部分问题。本项目不会再做一个通用 Eval（模型评测）克隆，而是专注于 **Eval 之后的回归诊断**：接收已经固定好的基线结果和候选结果，形成可验证的根因假设，再用消融实验收集证据。

完整工作流是：

```text
Baseline → Candidate → Regression → Cluster → Diff → Hypothesis → Ablation → Evidence → Report
  基线       候选         回归          聚类      差异       假设          消融        证据       报告
```

| 阶段                              | 通俗解释                                                   |
| --------------------------------- | ---------------------------------------------------------- |
| Baseline（基线）                  | 当前可信、用来比较的 Prompt 版本及评测结果                 |
| Candidate（候选）                 | 新修改、需要检查的 Prompt 版本及评测结果                   |
| Regression（回归）                | 同一测试题在候选版本中从好变坏，或关键指标明显下降         |
| Failure Cluster（失败聚类）       | 把表现相似的失败用例归到一起，避免逐条猜原因               |
| Prompt Diff（提示词差异）         | 按稳定的片段 ID 找出新增、删除或改写的 Prompt 内容         |
| Root-cause Hypothesis（根因假设） | 指出“哪个修改可能通过什么机制导致哪类失败”，此时还不是结论 |
| Ablation（消融实验）              | 只撤回一个修改，其他条件保持不变，再运行目标组和对照组     |
| Evidence（证据）                  | 比较目标用例是否恢复、正常用例是否受损，并保存完整引用关系 |
| Diagnosis Report（诊断报告）      | 汇总回归事实、假设、实验、支持和反对证据，以及下一步行动   |

核心原则：LLM 可以帮助提出假设，但不能直接宣布根因。一个假设只有经过受控消融，才可以从 `hypothesized`（待验证）变成：

- `supported`（当前证据支持）；
- `rejected`（当前证据否定）；
- `inconclusive`（证据不足或相互冲突）。

这些状态描述的是本次实验的证据强度，不是对所有模型、数据和环境都成立的永久因果结论。

## 这一阶段已经实现什么

当前 Python reference core（参考诊断核心）完成了一条窄而真实的垂直链路：

- `v1alpha1` 版本化 JSON 输入与输出合同，可明确拒绝未知版本、错误引用和被篡改的 Prompt 内容哈希；
- 成对比较相同测试用例的基线与候选结果，识别硬失败和指标下降；
- 基于稳定片段 ID 的 Prompt 差异、基于失败元数据的确定性聚类，以及规则化根因假设；
- 单片段回退的消融计划，分别保留目标用例和对照用例；
- 根据恢复比例、对照组损伤和最小样本数生成证据，并更新假设状态；
- 防止“平均数掩盖单个严重损伤”：支持结论还要求每个硬失败目标都恢复、不能产生新的对照失败，并检查最坏单例对照损伤；
- 字节级可重复的报告 ID，以及 JSON 和 Markdown（人可以直接阅读的文档）输出；
- 默认拒绝执行未知代码的 Plugin SDK（插件开发包）和版本化插件清单合同；
- 首个官方 Promptfoo v3 导入器：严格对齐两次运行并拒绝模型、Provider（模型服务配置）、评判器或测试集发生变化的混杂比较；
- Node.js 到 Python Core 的受限进程适配器，以及 `POST /v1/diagnoses` HTTP 诊断接口；
- 输入/输出大小限制、超时、请求取消、并发上限和不会向客户端泄露进程错误详情的错误边界；
- Web 回归诊断工作台：可拖入文件或粘贴 Canonical Bundle，执行基础预检查、取消/重试，并用中文展示 Prompt 变化、失败组、假设、最坏对照损伤和建议；
- 版本化 PostgreSQL 初始迁移，以及诊断输入、状态、成功报告和安全失败原因的持久化；网页可刷新历史并重新打开成功报告；
- 不依赖外部服务的示例数据和自动化测试。

目前的 Mock ablation fixture（模拟消融夹具）只读取示例文件中**事先明确写出的结果**，用于验证管线、引用关系和判定规则。它不会调用真实模型，也不会推测或伪造模型输出，因此不能证明某个 Prompt 在真实业务中有效。

## 五分钟运行第一条诊断链路

前置条件：Python 3.12 或更高版本。当前 reference core 只使用 Python 标准库，不需要先安装第三方依赖。

### Windows PowerShell

在仓库根目录运行：

```powershell
$env:PYTHONPATH = "packages/python/core/src"
python -m prompt_regression_core validate examples/missing-information-regression/regression-bundle.json
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --out diagnosis-report.json --require-supported-hypothesis
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --format markdown --out diagnosis-report.md
```

### macOS / Linux

在仓库根目录运行：

```bash
export PYTHONPATH="packages/python/core/src"
python -m prompt_regression_core validate examples/missing-information-regression/regression-bundle.json
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --out diagnosis-report.json --require-supported-hypothesis
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --format markdown --out diagnosis-report.md
```

`validate` 只检查输入是否完整一致；`diagnose` 执行完整诊断。JSON 供程序继续处理，Markdown 供人直接审阅。参数 `--require-supported-hypothesis` 会在检测到回归却没有任何假设通过证据门槛时返回非零状态码，可作为 CI（持续集成自动检查）门禁。

运行测试：

```powershell
python scripts/run-python-tests.py
pnpm test
```

第一条运行 Core、Plugin SDK 和官方导入器的全部 Python 测试；第二条同时运行 Python 与 TypeScript 测试。

示例的业务含义见[缺失信息回归示例](./examples/missing-information-regression/README.md)，字段解释见[数据合同说明](./contracts/README.md)。

## 技术架构与每项技术的职责

| 技术或模块                     | 它负责什么（通俗解释）                                     | 当前边界与后续方向                                                             |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Python 3.12 reference core     | 保存领域对象和诊断算法，是不依赖厂商的“推理发动机”         | 确定性链路和严格因果门槛已实现；仍需真实重复实验和统计区间                     |
| JSON Schema Draft 2020-12      | 规定输入、报告和插件清单必须长什么样，相当于“统一表格模板” | 三份 `v1alpha1` 合同已严格校验；稳定版前仍可能破坏性升级                       |
| Python `Protocol` + Plugin SDK | 给外部能力提供“标准插座”和版本/信任检查                    | 已有 11 类扩展点与显式加载器；不受信插件未来仍需进程或容器隔离                 |
| Promptfoo 官方导入器           | 把两次 Promptfoo 评测变成统一 Bundle                       | v3 已实现且保留来源；Langfuse、OpenInference 和通用 CSV 尚未实现               |
| CLI + 自动化测试               | 让管线在终端和 CI 运行，并在没有真实 LLM 时测试            | JSON/Markdown 输出、跨语言合同测试已可用；后续增加性质测试和性能基线           |
| React + Vite + TypeScript      | Prompt 管理与诊断结果网页                                  | 主流程 Chromium 验收已通过；逐 case 下钻、空项目逐页验收及窄屏检查待补         |
| Fastify + TypeBox              | 网页与 Core 之间的 HTTP 入口                               | 个人会话、项目角色、幂等启动、限流和受保护指标已实现；企业账号与共享限流待补   |
| PostgreSQL + Drizzle           | 保存项目、版本、运行和报告                                 | 版本、诊断和隔离恢复已验证；组织级隔离、迁移升级及时间点恢复仍需完善           |
| Redis + BullMQ + Node Worker   | 派发真实模型评测并记录结果                                 | 已有加密连接、预估预算、取消和故障重投；付费模型、生产容量与更快租约恢复待验收 |

短期不需要更换 React、Fastify、PostgreSQL 或 BullMQ；真正需要改变的是边界：诊断语义留在稳定 Core，Web/API/Worker/数据库通过版本化合同和 ports（接口）连接它。这样以后替换模型厂商、队列或数据库时，不必重写“什么算回归、什么算证据”。具体原因记录在 [ADR 0001：诊断层边界](./docs/adr/0001-diagnosis-layer-boundary.md)、[ADR 0002：Python 参考核心](./docs/adr/0002-python-reference-core.md)和[ADR 0004：端口与适配器](./docs/adr/0004-ports-and-adapters.md)。

## 仓库结构

```text
contracts/                    与语言无关的输入/报告 JSON 合同
packages/python/core/         稳定领域模型、诊断管线、策略接口与 CLI
packages/python/plugin-sdk/   插件清单、版本兼容和显式信任加载边界
packages/diagnosis-engine/    Node 调用 Python Core 的受限进程适配器
examples/                     可重复运行的最小诊断场景
plugins/official/promptfoo/   Promptfoo v3 成对评测导入器与 CLI
plugins/                      其他正式/社区适配器的边界与安全规则
experimental/                 尚无兼容承诺的算法试验区
docs/adr/                     重要技术选择及其原因
apps/api, apps/web, apps/worker
                              HTTP 诊断入口及 Web/后台任务产品层
packages/contracts, db, queue/
                              原有 TypeScript 合同、数据和队列基础
```

主要入口：

- [Regression Bundle 输入合同](./contracts/regression-bundle/v1alpha1.schema.json)
- [Diagnosis Report 输出合同](./contracts/diagnosis-report/v1alpha1.schema.json)
- [Plugin Manifest 插件合同](./contracts/plugin-manifest/v1alpha1.schema.json)
- [Python Core 说明](./packages/python/core/README.md)
- [Promptfoo 导入器说明](./plugins/official/promptfoo/README.md)
- [假设与证据状态机](./docs/adr/0005-hypothesis-evidence-state-machine.md)
- [总体架构](./docs/ARCHITECTURE.md)与[路线图](./docs/ROADMAP.md)

## 开源代码复用政策

项目整体采用 [Apache License 2.0](./LICENSE)。当前这条诊断链路**没有复制** Promptfoo、Langfuse 或 Phoenix 的源代码，它们只是设计参考。

未来确有必要复用代码时，必须核对精确文件和 Commit（提交版本）、保留许可证与版权声明，并记录来源和修改。可以评估经过版本核验的 Promptfoo MIT 代码及 Langfuse 非 `ee/` 的 MIT 代码；不得把 Langfuse `ee/` 代码或 Phoenix 主仓库的 Elastic License 2.0 代码复制进 Apache-2.0 Core。完整规则见[第三方声明](./THIRD_PARTY_NOTICES.md)、[代码来源清单](./docs/code-provenance.yml)和[ADR 0006](./docs/adr/0006-third-party-code-reuse.md)。

## 安全与贡献

- 当前版本适合本地、内网或受控的单团队部署；公网部署前必须完成[安全部署检查单](./docs/SECURITY_DEPLOYMENT.md)，不要把开发环境直接暴露到公网；
- 发现漏洞请阅读[安全政策](./SECURITY.md)，不要创建公开漏洞 Issue；
- 提交代码前请阅读[贡献指南](./CONTRIBUTING.md)和[行为准则](./CODE_OF_CONDUCT.md)。
