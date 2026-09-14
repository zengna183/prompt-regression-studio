# 缺失信息场景：回归诊断示例

这个例子对比同一个 Prompt 的两个版本：

- 基线版本要求“信息不足时先追问，不能猜”；
- 候选版本改为“优先给出最可能答案”；
- 两条缺失信息用例发生退化，两条普通问题保持正常；
- Mock 消融只把被修改的策略片段换回旧版本，并使用文件里明确给出的结果；
- 只有目标用例恢复、对照用例不受损，假设才会变成 `supported`。

Mock 结果是可重复测试夹具，不是真实模型输出，也不用于证明产品效果。

在仓库根目录运行：

```powershell
$env:PYTHONPATH = "packages/python/core/src"
python -m prompt_regression_core validate examples/missing-information-regression/regression-bundle.json
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --out diagnosis-report.json
```
