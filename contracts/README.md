# Prompt 回归诊断合同

这里的文件规定了 Prompt 回归诊断核心与导入器、运行器、界面之间交换的 JSON 形状。它们使用 JSON Schema Draft 2020-12，不依赖某一家模型、评测平台或编程语言。

## 三份合同

| 文件                                     | 根 `schema_version`                          | 用途                                                                                           |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `regression-bundle/v1alpha1.schema.json` | `prompt-regression.bundle/v1alpha1`          | 输入。把项目、Prompt、测试集、基线与候选评测，以及可重复使用的模拟消融结果打成一个不可变快照。 |
| `diagnosis-report/v1alpha1.schema.json`  | `prompt-regression.report/v1alpha1`          | 输出。保存回归事实、Prompt 变化、失败聚类、根因假设、消融计划与运行证据。                      |
| `plugin-manifest/v1alpha1.schema.json`   | `prompt-regression/plugin-manifest/v1alpha1` | 插件清单。声明插件身份、Core 兼容范围和明确入口，不负责安装或执行插件。                        |

`schema_version` 是解析入口，也是兼容性开关。只有根对象携带它；内部对象随根合同一起演进，避免每一层重复版本号。`bundle_id` 与 `report_id` 分别是输入、输出根对象的稳定 ID。

插件清单只是一份数据声明。校验清单不会导入插件代码；真正加载 Python 插件必须由宿主显式选择入口、检查 Core 版本范围并确认同进程执行的信任风险。JSON Schema 能检查版本格式，但 `minimum < maximum_exclusive` 和同一插件不得重复声明相同扩展点，仍由 Plugin SDK 检查。

## 输入字段怎么读

- `project`、`prompt` 和 `dataset` 说明本次诊断属于哪里。`dataset.test_cases` 是实际参与比较的测试用例。
- `baseline_prompt_version` 是已知基线，`candidate_prompt_version` 是怀疑发生退化的候选版本。每个 Prompt 由有稳定 `id` 的 `PromptSegment` 组成，`ordinal` 表示顺序，`semantic_tags` 用于解释和聚类。
- `PromptVersion.content_hash` 可以省略；核心会按规范化后的 `segments` 计算 SHA-256。若生产方提供该字段，消费方必须重新计算并核对，不能只相信传入值。
- `baseline_eval_run` 和 `candidate_eval_run` 必须固定 Prompt 版本、数据集、模型快照及评测器快照。每个 `EvalResult` 通过 `test_case_id` 回指测试用例，并包含一个或多个 `MetricResult`。
- `detection.primary_metric` 指定主要判断指标。`metric_drop_threshold` 是候选分数相对基线下降到何种程度才算退化；另外几个阈值控制最小目标/对照样本数、支持/否定假设所需的恢复比例和可接受的对照组损伤。
- `mock_ablation_results_by_segment` 是确定性测试入口：键是候选 Prompt 的 segment ID，值是撤回该片段变化后的 `EvalResult[]`。生产适配器可以用真实运行替代它；没有夹具时传空对象。

`TestCase.input`、`TestCase.expected`、`model_snapshot`、`evaluator_snapshot` 和 `metadata` 都是 JSON 对象。`expected` 可以省略或为 `null`。`metadata` 专门留给外部系统保存追踪 ID、标签等扩展信息，其中的值可以是任意合法 JSON；已经有正式字段的数据不要再塞进 `metadata`。

## 输出字段怎么读

- `regression.cases` 是检测到的逐用例回归事实。`kind` 区分硬失败、指标下降，或两者同时发生；`metric_deltas` 的值统一为“候选分数减基线分数”。
- `prompt_changes` 是 segment 级变化。`added` 的旧值必须为 `null`，`removed` 的新值必须为 `null`，`rewritten` 两侧都必须存在。
- `failure_clusters` 把相关回归用例分组，并记录实际使用的算法和版本。
- `hypotheses` 只表达可验证的根因假设。`verification_status` 从 `hypothesized` 开始，经过消融证据后才可以变成 `supported`、`rejected` 或 `inconclusive`。
- `ablation_plans` 只保存 `variant_ids`；具体不可变变体放在 `ablation_variants`。`ablation_runs` 中的 `Run` 记录某个变体的完整 `EvalRun`，方便复查原始输出与指标。
- `evidence` 把假设、失败聚类、Prompt 变化和消融运行串起来，并明确证据立场、目标组/对照组变化、样本数及解释。`recommendations` 是由这些证据导出的行动建议，不应写成未经验证的确定因果结论。
- `evidence.recovery_ratio` 是相对于原始回归差距的实际恢复比例：消融让结果更差时可以小于 0，超过基线时可以大于 1，无法计算时为 `null`。
- `evidence.max_observed_control_damage` 是单个对照用例中观察到的最坏损伤，不能被其他对照的改善抵消；`unrecovered_hard_targets` 和 `new_control_failures` 分别记录仍未恢复的硬失败目标、以及消融新造成的对照失败。三者都是支持结论的结构化判据，不只写在说明文字里。
- `input_bundle_hash` 是诊断实际读取的规范化输入 bundle 的完整 SHA-256，用来防止同一 `bundle_id` 下内容被替换；`pipeline` 固定诊断引擎、引擎版本和配置哈希。只有输入哈希和 pipeline 快照都相同时，报告才可以按确定性结果比较。

## 严格对象与扩展数据

所有有固定业务含义的对象都设置了 `additionalProperties: false`。这样拼写错误或生产方偷偷增加的字段会立即被发现，而不是静默丢失。

只有以下“字典/扩展点”按其业务含义允许动态键：

- JSON 对象：`input`、`expected`、`metadata`、`model_snapshot`、`evaluator_snapshot`；
- `mock_ablation_results_by_segment`：动态键是 segment ID；
- `metric_deltas`：动态键是 metric key。

这不是允许任意顶层字段。若一个字段会影响诊断含义、阈值、归因或证据解释，应先进入正式合同并升级版本。

## Schema 校验之外仍要检查什么

JSON Schema 能检查形状，不能可靠表达“数组里的 ID 必须出现在另一个数组中”。导入器和核心还必须执行以下引用与完整性检查：

1. `prompt.project_id` 和 `dataset.project_id` 等于 `project.id`；两个 PromptVersion 的 `prompt_id` 等于 `prompt.id`，且基线与候选版本 ID 不同。
2. 两个 EvalRun 的 `dataset_id` 等于 `dataset.id`，`prompt_version_id` 分别指向对应基线/候选版本；用于 Prompt-only 诊断时，两侧非空的 `model_snapshot` 与 `evaluator_snapshot` 必须分别完全相同，否则比较存在混杂因素并被拒绝。
3. 同一作用域内的第一等实体 ID 不重复；每个 EvalRun 对同一个 `test_case_id` 最多有一个结果，结果只引用当前数据集中的测试用例。
4. 每个结果里的 `metric_key` 不重复，并且 `detection.primary_metric` 在参与比较和消融的结果中都存在。
5. `mock_ablation_results_by_segment` 的键引用基线或候选版本中的 changed segment；候选新增片段可被移除，基线中被删除的片段也可被回加。其结果只引用当前数据集中的测试用例。
6. 报告里的 cluster、hypothesis、plan、variant、run、evidence 等 ID 引用必须能在同一报告或源 bundle 中解析，不能产生孤儿引用；报告的 bundle、PromptVersion 和 EvalRun ID 必须与源 bundle 一致。
7. 哈希均为规范 JSON 的完整、小写十六进制 SHA-256；时间使用带时区的 RFC 3339 `date-time`。

这些规则失败时应明确拒绝输入或报告，不能自动猜测、补连或用空证据冒充成功。

## 版本与兼容性

`v1alpha1` 表示第一版试验合同，公开稳定版之前仍可能有破坏性变化。建议按以下规则处理：

- 消费方只接受自己明确支持的完整 `schema_version`，遇到未知版本应报错；不要把未知版本当成最接近的旧版本继续运行。
- 因为固定对象是严格的，新增或改名正式字段、改变必填性、枚举或数值语义时发布新版本（例如 `v1alpha2`），不要原地改写已发布合同。
- 只在 `metadata` 中增加不影响诊断语义的外部信息，通常可保持同一版本；一旦核心开始依赖它，就必须提升为正式字段并升级合同。
- Bundle 与 Report 分别版本化。升级输入合同不代表旧报告自动改变；迁移工具应显式读取旧版、写出新版，并保留原 ID、来源版本和可审计的迁移记录。
- 保存或传输 JSON 时使用稳定键排序、UTF-8 和标准 JSON 数值；禁止 NaN、正负无穷及依赖运行环境的隐式类型转换。
