---
title: 故障与恢复
description: 处理 Console、Core、Chrome、Session 和页面状态变化。
---

BPA 的恢复目标不是“什么都重试”，而是在可以证明安全的边界内继续。

## Console 被关闭

关闭工作台只会结束当前 UI Session，不会停止 Local Core 或正在执行的 Run。重新
运行 `bpa console`，再按 Run ID 查看时间线。

## Core 重启

Core 从 SQLite 读取冻结 IR2、Checkpoint、Execution Identity、Inbox/Outbox、
Lease 和 Fencing 状态。恢复使用 Run 创建时保存的计划，不重新编译已经变化的资产。

## Chrome 或 Extension 重连

Bridge 会尝试恢复原 Browser Session，并补发未确认 Result 和 Evidence Chunk。
幂等键防止重复消费，Fencing 防止旧执行者推进状态。

## 页面发生变化

Tab、Origin 或 Page Epoch 不匹配时，Bridge 拒绝沿用旧页面上下文。Adapter 可以在
有限 Readiness/刷新策略内恢复；验证码、登录或风险控制必须交给人工任务。

## 什么时候不能自动继续

- 页面写动作是否已经生效无法判断。
- 数据集或资源绑定的前置摘要已经变化。
- 证据没有完成摘要验证。
- Browser Capability 或认证等级不再满足要求。
- 页面结构连续异常并触发熔断。

这些情况会进入失败、人工暂停或 `uncertain`，而不是无限重试。

执行原理见[执行、恢复与幂等](../../platform/runtime-recovery/)。
