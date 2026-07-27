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

Workflow 和 Node 使用 `bpa/v1alpha1`。Alpha 模型可以调整字段和约束；消费者必须固定所支持的版本，不应把它们宣传为稳定接口。

## 运行版本固定

一次 Run 创建后，应固定 Workflow、Node、协议和能力版本。发布新版本不会改变已经运行的任务。

## 公共文档基线

首版文档以 2026-07-27 的已确认 Browser Protocol v1 为基线。页面状态与下载 Schema 必须一致；网站解释不能覆盖机器规范。
