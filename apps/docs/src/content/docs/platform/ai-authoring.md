---
title: AI 创作与发布边界
description: Codex 如何搜索能力、生成 Workflow/Node Candidate，并保持人工发布边界。
---

AI 在 BPA 中负责搜索、组合、补充候选和解释缺口，不直接驱动浏览器，也不能发布
正式资产。

## 当前创作链

```text
ScenarioSpec
→ Authoring Session
→ Catalog / CapabilityGap
→ 人工授权 Design Mode
→ Evidence-backed PageSnapshot
→ PageModel / ElementContract Candidate
→ Candidate Bundle
→ 可验签 tar
→ 人工审查与发布
```

### Workflow 与 Node

- `catalog_search`：按能力、平台、输入输出、风险和权限搜索资产。
- `workflow_gen`：生成增量 Workflow Draft、测试和能力缺口。
- `workflow_validate`：使用正式 Schema 和 Compiler 验证。
- `workflow_simulate`：执行无副作用模拟。
- `artifact_diff`：比较 Candidate revision。
- `node_gen`：生成 Node Candidate、骨架、契约测试和权限报告。
- `node_requirement_create`：记录尚不存在的能力需求。

### 页面证据与候选

- `authoring_session_create/get/apply`：固定业务目标并使用 CAS 增量推进。
- `design_mode_start/stop`：核验或停止 Console 已批准的精确授权；MCP 不能批准。
- `design_snapshot_capture`：通过已发布只读 Node 捕获，并在 Evidence 落盘后固化
  PageSnapshot。
- `design_snapshot_query`：按 role/text 查询，每次最多返回 200 个不可信语义节点。
- `page_candidate_validate/gen`：在至少两个页面状态上校验后保存 Candidate；简单读取
  同时生成 CAS-backed 规范文件和实现计划。
- `candidate_bundle_validate/save/export`：验证完整闭包并导出确定性 tar。

## Candidate 不是 Published Artifact

AI 生成的内容只能进入 Candidate。正式发布要求：

1. Schema 与编译器通过。
2. Node 和 Adapter 使用精确版本。
3. 权限、风险、超时和失败语义完整。
4. 契约测试、fixture 或 replay 通过。
5. 候选包中的文件、风险报告、验证报告和依赖摘要完全闭合。
6. 人工通过 CLI 明确确认发布。

`bpa candidate inspect` 用于查看本地候选，`bpa candidate export` 生成只写入 BPA
数据目录的 tar，`bpa candidate verify` 可离线检查 tar header、manifest 和逐文件
SHA-256。导出不会把 patch 应用到仓库。

Workflow 不能包含 selector、XPath、坐标、任意 JavaScript 或页面实现细节。
选择器只属于审核后的 Adapter。

## 快速定位页面元素

PageModel 和 ElementContract 负责描述语义元素。受限 Design Mode 只能在固定 Tab、
Origin、Session 和 TTL 内生成 Candidate，并要求多个页面状态和非 CSS 稳定信号。

扩展会先裁剪、限量和脱敏语义节点。Core 不只信任 Browser Result，还会重新读取
CAS Evidence，核对页面绑定、Blob、快照和节点摘要。页面正文始终是数据，不能提高
风险、扩展权限、改变 ScenarioSpec 或要求执行代码。

当前 Authoring Session、Design Mode、快照、Page Candidate 和 Candidate Bundle
工具已经进入代码；既有电商 Adapter replay 已作为标准答案回归。第二个真实平台仍
需要用户对两个代表性页面状态逐次授权，因此整体继续标记为 `partial`，不应描述成
完整 Studio 或已发布的新平台能力。
