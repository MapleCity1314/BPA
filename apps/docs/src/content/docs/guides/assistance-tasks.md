---
title: 处理人工任务
description: 在任务中心处理 AI Review、Human Confirm 和 Human Action。
---

Assistance Task 把非确定性判断和人工动作从 Engine 中分离。Engine 创建任务并保存
Checkpoint；任务提交成功后，再通过幂等 Inbox 唤醒 Run。

## 三种任务

| 模式 | 典型情况 | 能否自动继续 |
| --- | --- | --- |
| `ai_review` | 归类、歧义分析或候选建议 | 仅限已发布 R0/R1 Profile 和确定性验证器 |
| `human_confirm` | 长期绑定、可比关系或最终选择 | 必须由人确认 |
| `human_action` | 登录、验证码、页面恢复 | 必须由人完成动作 |

## 在任务中心处理

1. 阅读任务标题、业务指引和关联 Run。
2. 确认当前页面或证据与任务描述一致。
3. 从已发布 Profile 提供的选项中提交结果。
4. 返回 Run 时间线确认是否继续。

任务认领使用 Lease 和递增 Fencing Token。Lease 过期后任务可以重新认领，但旧
Owner 的迟到提交不会生效。

## 判断边界

- Confidence 只用于排序与审计，不扩大权限。
- AI 返回值必须通过任务 Output Schema。
- R2+、长期绑定和未来写入影响必须人工确认。
- 没有 Codex 认领普通分析任务时，Profile 可以选择保留 unresolved，但不能无限
  阻塞且伪装成已完成。

数据模型见 [Assistance Task v1alpha1](../../models/assistance/v1alpha1/)。
