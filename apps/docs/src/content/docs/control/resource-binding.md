---
title: Browser Resource Binding
description: Node Requirement、Workflow Slot、Run Binding Snapshot 与派发前复核。
---

资源绑定解决“一个 Workflow 需要多个浏览器来源，但恢复时不能偷偷换 Session”的
问题。

## 三层模型

```text
Node v1alpha2 Requirement
        ↓ mapped by
Workflow v1alpha3 Resource Slot
        ↓ bound at run creation
exact Browser Session Snapshot
```

Node Requirement 声明所需能力、允许 Origin、最低认证等级和用途。Workflow Slot
聚合业务层的资源需求，并将每个 Call 的本地 Requirement 映射到一个命名 Slot。

## Run 启动时冻结

- 精确 Session ID。
- Capability Manifest Digest 和能力集合。
- Origin 范围。
- 认证等级。
- 绑定时间和批准主体。

缺少任意必需 Slot 时 Run 不启动。Slot 不能从普通 Workflow input、页面内容或
Node 输出生成。

## 每次派发仍要复核

冻结不等于永远有效。Browser Provider 在每次执行前重新检查 Session、能力摘要、
Origin、认证等级和状态。失效时暂停对应 Checkpoint，并创建人工接管任务；不会自动
选择另一个 Session。

同一个 Browser Node 当前不能跨多个 Session 执行。需要多个来源时，Workflow 应拆成
多个顺序 Call，并分别映射资源槽位。
