---
title: Workflow v1alpha2 / v1alpha3
description: 结构化 sequence、call、decision、foreach、Assistance 与 Browser Resource Slot。
---

Workflow v1alpha2 使用结构化块替代任意跳转；v1alpha3 在同一执行模型上增加 Browser
Resource Slot。

## v1alpha2 Step

```text
sequence
├── call
├── decision
├── foreach
├── wait.assistance
└── terminal
```

绑定只允许 `${input...}`、`${steps.<key>.output...}`、`${item...}` 和
`${index}`。decision 使用结构化 `compare / all / any / not`，不接收表达式字符串。

## foreach

- 顺序执行。
- 最多 500 项，并有总时限。
- `itemKey` 必须稳定且唯一。
- `stop` 遇到第一项失败就停止。
- `collect` 可以收集普通失败，但 `uncertain` 始终停止。
- 输出按输入顺序聚合 succeeded、failed 和 unresolved。

## Assistance

`wait.assistance` 可以阻塞或非阻塞。阻塞任务的创建与 Run 暂停属于同一事务。Provider
不可用时，只能使用已发布 Profile 固定的升级策略。

## v1alpha3 Resource Slot

v1alpha3 的 `resourceSlots` 声明能力、Origin、认证等级和用途；Call 使用
`resourceMappings` 把 Node Requirement 映射到 Slot。Run 创建时再绑定精确 Browser
Session。

v1alpha1、v1alpha2 和 v1alpha3 都编译到 `bpa.workflow-ir/2`。已有 Run 不会因新
Workflow 版本重新编译。
