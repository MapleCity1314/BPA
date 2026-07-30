---
title: 版本与兼容
description: BPA 协议族、Schema 版本、Alpha 模型和兼容性规则。
---

## Protocol 与 version

`protocol` 表示不兼容的协议族和 Major，例如 `bpa.browser/1`。`version` 是该 Major 内的完整 Schema 版本，例如 `1.0.0`。

连接双方先协商协议族，再按完整 Schema 校验每条消息。

## v1 兼容规则

- 未知字段严格失败，不以猜测方式兼容。
- 新增消息或字段需要发布新的完整 Schema 版本，并通过双端兼容测试。
- 删除字段、改变既有含义或放宽安全约束必须升级 Major。
- Permission Grant、Fencing、Deadline 与风险阻断不能通过 Minor 版本降级。

## Alpha 模型

当前 Workflow 支持 `bpa/v1alpha1`、`bpa/v1alpha2` 和 `bpa/v1alpha3`；Node
支持 `bpa/v1alpha1` 和 `bpa/v1alpha2`。Alpha 模型可以调整字段和约束；消费者
必须固定所支持的版本，不应把它们宣传为稳定接口。

- Workflow v1alpha2 引入结构化 sequence、decision、foreach 和 Assistance。
- Workflow v1alpha3 引入 Browser Resource Slot。
- Node v1alpha2 引入 Browser Resource Requirement。
- Source、Asset、Evidence Link、Dataset、Decision、Assistance 与页面模型仍是
  v1alpha1。

## 运行版本固定

一次 Run 创建后，应固定 Workflow、Node、协议和能力版本。发布新版本不会改变已经运行的任务。

v1alpha1/v1alpha2/v1alpha3 Workflow 都编译为 `bpa.workflow-ir/2`。IR 标识不随源
Workflow Alpha 版本变化；Run 恢复使用保存的 IR2 和资产闭包。

## 公共文档基线

当前文档以 2026-07-30 的已确认 Browser Protocol v1、Control Hello 和资源/证据
协议边界为基线。页面状态与下载 Schema 必须一致；网站解释不能覆盖机器规范。

## 兼容矩阵

| Producer | 接受的源版本 | 冻结形式 |
| --- | --- | --- |
| 新 CLI/MCP/Console | `bpa.control/hello/1` → `bpa.control/1` | 协商后的帧上限与功能快照 |
| 旧 Workflow | v1alpha1 / v1alpha2 | IR2 Plan Snapshot |
| 资源感知 Workflow | v1alpha3 | IR2 + Resource Binding Snapshot |
| 旧 Node | v1alpha1 | 不可变 Node Closure |
| 资源感知 Node | v1alpha2 | Requirement + Node Closure |
| Browser Runtime | `bpa.browser/1@1.0.0` | Session、Command 和 Evidence 状态 |

已有 Run 不会自动获得新的 Resource Slot、Adapter Readiness 或资产版本。
