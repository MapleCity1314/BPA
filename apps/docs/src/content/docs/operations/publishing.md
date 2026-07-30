---
title: 正式资产发布
description: 验证并人工发布 Workflow、Node、Adapter、Profile、Policy 和页面资产。
---

正式发布是人工治理动作，不放入普通 Operator Console，也不允许 MCP/Codex
代替确认。

## 验证 Candidate

```bash
bpa validate <asset-type> <path>
```

`asset-type` 可以是 Workflow、Node、Adapter、Profile、Policy 或 Page Asset。
验证会检查 Schema、固定版本、权限、风险、编译能力和适用的契约。

## 人工发布

确认验证结果和摘要后：

```bash
bpa publish <asset-type> <path> --yes
```

发布记录操作者、时间、规范化 JSON 和 SHA-256。相同 `asset_id + version` 不能
覆盖；内容变化必须使用新版本。

## 发布前检查

- Candidate diff 与预期一致。
- 没有 selector 或脚本泄漏到 Workflow。
- Browser Node 的 Origin、权限和风险等级收敛。
- Adapter/Handler 是安装包内审核实现。
- 测试覆盖成功、失败、超时、恢复和迟到结果。
- R2+ 或长期决定已经获得单独人工授权。

审计可以通过 `bpa audit` 查询。AI 创作流程见
[AI 创作与发布边界](../../platform/ai-authoring/)。
