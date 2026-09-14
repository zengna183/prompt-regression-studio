# Plugins

这个目录预留给诊断 Core 之外的适配器和策略。依赖方向只能是：

```text
plugin -> prompt_regression_core public ports
```

Core 不得导入这里的任何实现。

## 分类

- `official/`：由本项目维护者发布、进入兼容矩阵和安全响应范围；
- `community/`：社区维护的索引或示例，不代表核心维护者背书；
- `experimental/` 不放在这里，而位于仓库根 `experimental/`，其 API 没有兼容承诺。

当前 `v1alpha1` 只公开了 Python `Protocol` 扩展点，还没有承诺稳定的第三方加载器或 manifest。M1 会增加版本协商、能力声明、契约测试和明确安装流程。在此之前，插件不得被生产服务自动发现或自动加载。

## 安全规则

Python/Node 插件与应用同进程运行时，拥有与应用相同的文件、网络和 Secret 权限，等价于执行第三方代码。未来的默认行为必须是管理员明确安装和信任；仅有插件名称或远程 manifest 不能授权执行代码。
