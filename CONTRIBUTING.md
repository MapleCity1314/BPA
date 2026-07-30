# Contributing to BPA

BPA 接受围绕文档、Schema、测试、受信 Node、Adapter 和本地运行时的贡献。提交前请先
阅读 [`docs/AI-START-HERE.md`](docs/AI-START-HERE.md)，不要根据归档或计划文档推断
当前契约。

## 开发环境

- Node.js 24
- pnpm 10.32.1
- macOS arm64（涉及 Runtime、Native Host 或真实 Chrome 时）

```bash
pnpm install --frozen-lockfile
pnpm verify
```

## 变更要求

- JSON Schema 是公共模型的唯一事实来源；不要手改生成类型。
- Workflow 不得包含 selector、XPath、坐标或任意 JavaScript。
- AI 只能生成 Candidate，正式发布必须由人确认。
- 新增行为应覆盖成功、失败、恢复、重复投递和权限拒绝。
- 文档新增、移动或删除必须更新 `docs/catalog.json`。
- 不要提交真实账号、业务页面正文、凭据、本地 Runtime 数据或签名密钥。

Pull Request 应说明行为变化、安全影响、验证结果，并为 UI 变化附上截图。
