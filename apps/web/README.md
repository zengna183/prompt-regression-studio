# Web 应用

衡鉴的 React + TypeScript 管理界面。当前纵向功能包括：

- 创建和选择项目；
- 创建和选择 Prompt；
- 使用稳定区块 ID 创建 Prompt 版本；
- 查看版本历史并发布草稿；
- 拖入 JSON 文件或粘贴 Canonical Regression Bundle；
- 运行、取消、重试 Prompt 回归诊断；
- 阅读 Prompt 改动、失败组、假设、消融证据和下一步建议；
- 刷新最近诊断，并重新打开 PostgreSQL 中已经保存的成功报告；
- 所有数据均来自真实 API，不生成模拟评测结果。

网页会先做轻量的格式检查，完整合同和因果证据检查仍由服务端的 Python Core 执行。完成数据库迁移后，输入、运行状态、成功报告或安全失败原因都会保存；网页历史列表不显示完整输入内容，避免无意泄露对话数据。

## 本地运行

在仓库根目录配置 `.env` 中的 `VITE_API_URL`，然后运行：

```bash
pnpm --filter @ai-chat-eval/web dev
```

默认访问地址为 `http://localhost:5173`。API 默认地址为 `http://localhost:4000`。
