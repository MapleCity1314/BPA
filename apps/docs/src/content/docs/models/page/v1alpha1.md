---
title: Page Model 与 Readiness
description: PageModel、ElementContract、受限 Design Mode 和 Adapter-owned Readiness Contract。
---

## PageModel 与 ElementContract

PageModel 描述页面状态、语义元素和精确 Adapter 关系。ElementContract 描述一个语义
意图可使用哪些稳定定位策略、前后置条件和已验证快照。

ElementContract Candidate 至少需要：

- 两个不同的脱敏页面快照摘要。
- 至少一个非 CSS 的稳定策略。
- 明确的 Origin、页面状态和预期数量。
- 无 XPath、坐标和任意脚本。

## Design Mode

Design Mode 绑定精确 Tab、Origin、Session 和最长 15 分钟 TTL。它只读、脱敏，只能
创建 PageModel、ElementContract 或 Adapter Candidate，不能发布正式资产。

复杂分页、虚拟滚动、导航恢复和未来写动作必须由审核 Adapter Handler 实现，不能由
声明式定位器替代。

## Readiness Contract

Readiness 属于精确 Adapter 发布闭包，不进入 Workflow。它只允许：

- 语义目标出现。
- DOM 在有限窗口保持安静。
- 网络在有限窗口保持安静。
- 资产数量连续多次稳定。

Contract 固定总超时、采样间隔和最多三次刷新。第一次扫描为 0 只是一条样本，不能
单独证明页面确实为空。

当前 Readiness Contract 的结构与解析已经进入代码；复杂真实页面的延迟渲染、刷新
恢复和空状态仍需要实际 replay 验收。
