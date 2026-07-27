---
title: Timing 与 Risk
description: TimingPolicy 的有界等待与 RiskSignal 的明确阻断语义。
---

Browser Protocol v1 允许 `command.dispatch` 携带已经由 Compiler 解析的 `timing_policy`，并允许 `command.result` 返回结构化 `risk_signals`。

这些字段不会授权新动作，也不能扩大 Permission Grant。

## TimingPolicy

TimingPolicy 可以定义四类有界行为：

| 分组 | 作用 | 主要边界 |
| --- | --- | --- |
| `readiness` | 等待页面就绪并保持稳定 | 超时不超过 120 秒 |
| `dispatchJitter` | 在有限区间内分散调度 | 最大 10 秒 |
| `retryBackoff` | 固定或指数退避 | 最大等待 120 秒 |
| `rateLimit` | 按域名、店铺或 Tab 限速 | 队列上限 120 秒 |

所有实际等待都受 Command Deadline 约束。若等待会越过 Deadline，Bridge 不得继续执行。

抖动必须由确定性种子产生，才能在重放、审计和测试中得到相同结果。TimingPolicy 不是模拟真人操作的随机脚本。

## RiskSignal

RiskSignal 使用明确的代码、类别、严重级别和来源：

```text
CAPTCHA_REQUIRED
RATE_LIMITED
RISK_CONTROL
SESSION_EXPIRED
AUTH_REQUIRED
PAGE_CONTEXT_CHANGED
```

`severity: "blocking"` 表示当前动作必须停止。`warning` 可以记录并返回，但是否继续仍要满足权限、页面上下文和 Deadline。

来源只能是 `page`、`adapter` 或 `bridge`。可重试的限速信号可以携带 `retry_after_ms`，但这个建议值仍受 TimingPolicy 和 Deadline 限制。

## 不允许的行为

- 通过随机等待规避平台检测。
- 在验证码或登录失效后继续写操作。
- 把 TimingPolicy 当作权限。
- 因为收到 `RATE_LIMITED` 就无限重试。
- 在 Page Epoch 已变化时沿用旧元素引用。

机器定义见 [Timing Policy Schema](../../../reference/schemas/) 与 Risk Signal Schema。
