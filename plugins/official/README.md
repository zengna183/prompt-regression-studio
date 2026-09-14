# Official plugins

首个正式插件已经实现：[`promptfoo/`](./promptfoo/) 可把严格配对的 Promptfoo `EvaluateSummaryV3` 基线/候选导出转换为 Canonical Regression Bundle。

下一批计划是通用 JSON/CSV importer、Langfuse importer 和 Phoenix/OpenInference trace importer。每一个都必须通过同一套离线 contract tests，并独立记录许可证、字段映射和数据丢失规则。
