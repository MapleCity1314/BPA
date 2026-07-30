---
title: AI 创作与发布边界
description: Codex 如何搜索能力、生成 Workflow/Node Candidate，并保持人工发布边界。
---

AI 在 BPA 中负责搜索、组合、补充候选和解释缺口，不直接驱动浏览器，也不能发布
正式资产。

## 当前 MCP 创作工具

- `catalog_search`：按能力、平台、输入输出、风险和权限搜索资产。
- `workflow_gen`：生成增量 Workflow Draft、测试和能力缺口。
- `workflow_validate`：使用正式 Schema 和 Compiler 验证。
- `workflow_simulate`：执行无副作用模拟。
- `artifact_diff`：比较 Candidate revision。
- `node_gen`：生成 Node Candidate、骨架、契约测试和权限报告。
- `node_requirement_create`：记录尚不存在的能力需求。

## Candidate 不是 Published Artifact

AI 生成的内容只能进入 Candidate。正式发布要求：

1. Schema 与编译器通过。
2. Node 和 Adapter 使用精确版本。
3. 权限、风险、超时和失败语义完整。
4. 契约测试、fixture 或 replay 通过。
5. 人工通过 CLI 明确确认发布。

Workflow 不能包含 selector、XPath、坐标、任意 JavaScript 或页面实现细节。
选择器只属于审核后的 Adapter。

## 快速定位页面元素

PageModel 和 ElementContract 负责描述语义元素。受限 Design Mode 只能在固定 Tab、
Origin、Session 和 TTL 内生成 Candidate，并要求多个页面状态和非 CSS 稳定信号。

当前 PageModel、Readiness 和 Candidate 工具已经具备模型与测试基础，但复杂真实
页面的 Design Mode 闭环仍标记为部分完成，不应被描述成完整 Studio。
