# Experimental modules

这里用于尚未达到 Stable Core 质量门槛的算法实验，例如向量聚类、LLM 假设生成、Bootstrap 区间和 factorial ablation。

实验模块必须：

- 明确标注不稳定，不得让 Core 反向依赖；
- 使用匿名或合成数据，不能提交真实客户对话或密钥；
- 输出 `hypothesized`，不能绕过 EvidenceScorer 直接声明根因；
- 进入 Core 或 official plugin 前补齐确定性、失败、性能和契约测试。
