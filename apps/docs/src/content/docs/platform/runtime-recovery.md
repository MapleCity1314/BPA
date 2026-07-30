---
title: 执行、恢复与幂等
description: IR2 计划快照、事务边界、Inbox/Outbox、Fencing 与不确定终态。
---

## 创建 Run 时冻结什么

新 Run 原子保存：

- 规范化 IR2 JSON 与摘要。
- Workflow 源摘要、风险快照和精确资产闭包。
- 初始 Checkpoint、Event 和必要的 Outbox。
- Workflow v1alpha3 所需的 Browser Resource Binding Snapshot。

恢复时读取保存的计划，不重新编译当前仓库中可能已经变化的资产。

## 事务边界

状态、Event、幂等记录和跨进程投递意图必须进入同一 Unit of Work。跨进程不使用
分布式事务，而采用：

```text
local state change + Outbox
→ at-least-once delivery
→ Inbox deduplication
→ CAS state transition
```

`expected_revision` 防止并发覆盖；Fencing Token 防止过期执行者提交；幂等键防止
相同业务结果重复应用。三者解决的问题不同，不能互相替代。

## foreach 与人工暂停

foreach 当前按顺序执行，最多处理冻结上限内的条目。`collect` 可以收集普通失败后
继续，但 `uncertain` 必须停止。创建阻塞 Assistance Task 与暂停 Run 属于同一事务；
任务提交通过 Inbox 幂等唤醒原 Checkpoint。

## 为什么需要 uncertain

当写动作已经开始，但系统无法证明页面是否接受了副作用时，既不能标记成功，也不能
当作普通失败自动重试。`uncertain` 是需要人工核验的终态。

当前公开能力仍以只读 R0/R1 为主，但保留这一状态可以防止未来写节点采用危险的
“超时即重做”逻辑。

## 当前支持与拒绝

已支持顺序、结构化 decision、顺序 foreach、有限重试、人工等待、取消和恢复。
任意并行、通用 paginate、任意回边与无上限循环会在编译期拒绝。
