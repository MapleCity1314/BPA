---
title: Assistance Task v1alpha1
description: AI Review、Human Confirm、Human Action、Lease、Fencing 与自动继续边界。
---

Assistance Task 把非确定性判断和人工动作从 Engine 中分离出来。

## 模式

| 模式 | 用途 |
| --- | --- |
| `ai_review` | 结构化分析、归类或建议 |
| `human_confirm` | 确认、修正或拒绝长期决定 |
| `human_action` | 登录、验证码、切换页面或其他必须由人完成的动作 |

## 生命周期

```text
queued → claimed → processing → completed
                         └─────→ awaiting_human → completed

queued / claimed / processing → expired | cancelled | failed
```

Claim 使用可续租 Lease 和递增 Fencing Token。Lease 过期后可重新认领，但旧 Owner
不能提交。

## AI 自动继续

- R0 Profile 可以明确允许自动继续。
- R1 还要求白名单和确定性结果验证器。
- R2+、长期决定和未来写入影响必须人工确认。
- confidence 只用于排序与审计。

自动继续必须来自已发布 Profile 的 Policy Snapshot；没有快照时默认不能继续。
Codex 通过任务队列认领工作，Core 不直接调用模型 API。
