# 命令行、插件与 CI 接入

命令行适合开发者把检查接进自己的工程；普通用户可在网页诊断报告顶部下载完整 JSON、可读摘要和退化用例 CSV。两种入口都保留报告 ID 与输入指纹，便于确认讨论的是同一次评测。

## 安装与检查

Python 3.12 或更高版本，在仓库根目录创建独立虚拟环境，然后安装本仓库的软件包。目前尚未发布到 PyPI，不要假定可以直接从公共包站安装同名项目。

```sh
python -m pip install ./packages/python/core ./packages/python/plugin-sdk ./plugins/official/promptfoo
prompt-regression --version
prompt-regression validate examples/missing-information-regression/regression-bundle.json
prompt-regression check examples/missing-information-regression/regression-bundle.json --out-dir artifacts/my-check
```

示例包含两个退化用例，最后一个命令因此返回 `3`，同时保存全部报告。这是预期的门禁失败：找到退化原因并不表示新版 Prompt 已经修好。

| 退出码 | 意义                                                 | CI 应如何处理            |
| ------ | ---------------------------------------------------- | ------------------------ |
| `0`    | 输入有效且通过选定门槛                               | 允许后续步骤             |
| `2`    | 参数、数据或文件读写错误                             | 检查失败，不能当成无退化 |
| `3`    | 退化用例数超过允许值                                 | 阻止发布候选版本         |
| `4`    | 存在退化但没有受控证据支持的假设；仅在启用对应选项时 | 继续收集证据             |

`check` 默认 `--max-regressions 0`。如明确接受最多两个退化用例，可设置 `--max-regressions 2`；这会放宽质量门槛，需由项目负责人决定。`--require-supported-hypothesis` 额外要求存在至少一个通过证据门槛的假设，不表示每个失败都已得到解释。

输出目录包含：

- `report.json`：完整的版本化报告，含差异、假设、验证及证据引用；
- `report.md`：供人阅读的报告；
- `regressions.csv`：一行一个退化用例，保留主要指标差值，可用表格软件打开；
- `check.json`：门禁状态、退出码、原因、退化数量和输入指纹，供自动化系统读取。

报告原子写入单个文件；门禁不通过也会保留报告，输入错误时不保证有新报告。读取 `check.json` 前必须同时检查本次进程退出码，避免使用上次输出。建议每次使用新目录。CSV 会将可能被表格软件执行的文本公式转成文本，真正的数值差值仍保留为数值。

仅需要单种输出时，使用 `diagnose`：

```sh
prompt-regression diagnose paired-results.json --format json --out report.json
prompt-regression diagnose paired-results.json --format markdown --out report.md
prompt-regression diagnose paired-results.json --format csv --out regressions.csv
```

`diagnose` 默认只生成诊断报告，需要添加 `--max-regressions 0` 才具有退化数量门禁。`-` 表示从标准输入读取 JSON。CLI 使用固定配对结果进行诊断，不会隐式发起模型调用或自动重跑收费任务。

## 插件与 Promptfoo

检查插件声明及其与当前 Core 的兼容性：

```sh
prompt-regression-plugins validate plugins/official/promptfoo/prompt-regression-plugin.json
```

默认只读插件清单，不导入它声明的代码。开发者审核并信任插件后，可以显式检查其可加载性：

```sh
prompt-regression-plugins validate plugins/official/promptfoo/prompt-regression-plugin.json --load-kind EvalImporter --trust-in-process
```

`--trust-in-process` 表示允许插件在当前进程执行，SDK 不提供安全沙箱。不要将陌生用户上传的插件直接装进服务端。`--core-version` 适合在发布前检查目标版本；省略时读取实际安装版本。

Promptfoo 导入需要两次导出的完整配对请求，包括模型、评判配置及 Prompt 片段快照，具体结构见[官方导入器](../plugins/official/promptfoo/README.md)。导入后可以直接接统一检查：

```sh
prompt-regression-import-promptfoo import-request.json --out paired-results.json
prompt-regression check paired-results.json --out-dir artifacts/promptfoo-check
```

目前官方导入器支持 Promptfoo `EvaluateSummaryV3`，会拒绝版本不符、用例缺失、模型/评判配置混杂等输入。Langfuse、Phoenix 等系统的专用导入器仍需后续实现；插件接口可扩展不等于这些适配器已交付。

## 在其他 GitHub 仓库使用

在消费项目的工作流中加入以下步骤。`bundle` 是该项目检出的 JSON 文件路径；实际维护时把 `@main` 改成审核过的提交 SHA，固定所执行的代码。

```yaml
name: Prompt quality
on: [push, pull_request]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Check prompt changes
        id: regression
        uses: zengna183/prompt-regression-studio/.github/actions/prompt-regression@main
        with:
          bundle: eval/paired-results.json
          output-directory: artifacts/prompt-regression
          max-regressions: "0"
```

Action 会准备 Python、安装自带的 Core 与官方导入器，再执行一次检查。`input-format: promptfoo` 可直接处理 Promptfoo 的导入请求。输入和输出路径必须在消费项目内，输出目录必须不存在，避免失败时发布旧结果。支持包含空格的路径；输入值按数据传递，不作为终端代码执行。

输出包括 `report-directory`、`regression-count`、`passed`。超过门槛时步骤失败，但报告文件及门禁输出仍会生成。上面的工作流通过正常失败阻止后续发布；不要在生产门禁随意添加 `continue-on-error`。工作流摘要只展示数量与门禁原因，不写入 Prompt 或对话。报告可能包含业务数据，如需上传为工作流附件，应先确定仓库可见性和保存期限；本 Action 不自动公开上传报告、不评论 PR，也不需要写入仓库的权限。

仓库 CI 会从构建出的 wheel（Python 安装包）重新安装并验证导入与命令行，同时实际调用复用 Action，检查拒绝退化、显式容忍、报告输出、插件信任边界和错误输入。网页下载的 Markdown 是当前报告的可读摘要，CLI Markdown 是详细报告；JSON 为完整数据导出。
