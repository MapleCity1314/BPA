# BPA TimingPolicy 与 RiskSignal v1

> 文档类别：正式规范。

> 状态：本地 v1 实现基线
> 目标：吸收页面延时抖动、治理交互节奏、在平台风险出现时安全停止
> 非目标：隐藏自动化、伪造浏览器指纹、绕过验证码或规避平台风控

## 1. 设计边界

BPA 不把“拟人化”作为协议术语。该需求拆成三个可测试能力：

1. **自适应就绪**：等待业务条件成立并持续稳定，而不是依赖固定 `sleep`。
2. **节奏治理**：使用有界、可复现的调度抖动、重试退避和最小操作间隔，避免瞬时突发。
3. **风险信号**：识别验证码、频控、会话失效、风险提示和页面上下文变化，阻止自动继续。

随机性不是安全边界。所有延迟由已发布 Policy 约束，以
`run_id + node_key + attempt` 为 seed，可在 Event 中复现和审计。
Bridge 还会通过 `timing_observation` 返回实际的限速等待、就绪等待和稳定窗口，
Engine 将其写入对应节点终态 Event。

## 2. TimingPolicy v1

Canonical Schema：
[`timing-policy.schema.json`](../packages/schemas/schema/timing-policy.schema.json)

```yaml
timingPolicy:
  readiness:
    timeoutMs: 8000
    stableForMs: 300
    pollIntervalMs: 200
  dispatchJitter:
    minMs: 100
    maxMs: 500
    distribution: uniform
  retryBackoff:
    strategy: exponential
    baseMs: 1000
    maxMs: 5000
    jitterRatio: 0.2
  rateLimit:
    scope: tab
    minIntervalMs: 350
    maxQueueMs: 3000
```

约束：

- Schema 负责绝对上限，Compiler 负责跨字段关系检查。
- `stableForMs` 不得大于 `timeoutMs`。
- `minMs` 不得大于 `maxMs`，`baseMs` 不得大于退避上限。
- Workflow 可以增加等待，但不能降低 Published Node 的最小抖动和最小操作间隔。
- 延迟 Outbox 在 SQLite 中持久化；Core 重启后只在到期时投递。
- Deadline 优先于节奏策略。排队会越过 Deadline 时直接拒绝，不执行动作。

## 3. 自适应就绪

Content Script 使用 `MutationObserver` 接收页面变化，定时器仅作为无变化时的上限唤醒。
Adapter 每次被唤醒后重新读取业务上下文，并以稳定店铺 ID、名称和 URL 形成签名。
签名持续满足 `stableForMs` 后才返回结果。

等待期间必须重复检查：

- 当前 Origin 和 Path。
- 活动 Tab 与开始时是否一致。
- URL 是否发生导航。
- 是否出现 Blocking RiskSignal。
- Command Deadline 是否仍然有效。

## 4. RiskSignal v1

Canonical Schema：
[`risk-signal.schema.json`](../packages/schemas/schema/risk-signal.schema.json)

首批信号：

| Code | 含义 | 默认处理 |
| --- | --- | --- |
| `CAPTCHA_REQUIRED` | 页面要求验证码或安全验证 | 阻断，人工处理 |
| `RATE_LIMITED` | 平台或本地节奏策略触发频控 | 阻断，等待或人工检查 |
| `RISK_CONTROL` | 平台显示异常操作或账号风险 | 阻断，人工检查 |
| `SESSION_EXPIRED` | 跳转登录/授权页面 | 阻断，人工恢复会话 |
| `AUTH_REQUIRED` | 权限或审批缺失 | 阻断，不降级权限 |
| `PAGE_CONTEXT_CHANGED` | Tab、URL 或业务上下文变化 | 阻断，重新发起节点 |

Blocking Signal 通过 `command.result.risk_signals` 返回，并将 Result 标记为
`rejected`。Engine 不重试、不转入失败路由，也不执行自定义恢复；当前 Run 立即以
不可恢复的 `rejected` 终态结束。v1alpha1 的拒绝恢复字段已移除；规范化
`handlers.rejected` 如存在，也只能显式声明一个 `rejected` terminal，不能转到
Human Node。运营人员处理登录、权限、风控或人工拒绝原因后，应重新发起新的 Run。

## 5. 分层职责

```text
Node Definition
  └─ 声明安全默认 TimingPolicy
Workflow Compiler
  └─ 合并覆盖、拒绝弱化和矛盾配置
Engine
  └─ 计算确定性调度/退避、写入 Event 和延迟 Outbox
Browser Gateway
  └─ 将 Policy 纳入 Command，保留 Result 风险信号
Extension Bridge
  └─ Deadline、Tab 级限速、页面上下文复核
Adapter
  └─ 业务就绪探测和平台风险识别
```

## 6. 当前限制

- v1 只启用 Tab 级实际限速；`domain` 和 `shop` 已进入契约，后续写节点接入共享持久化 Limiter。
- Extension 的速率状态保存在 `storage.local`，Service Worker 内同时维护预约时间，避免同一存活周期并发突发。
- 首个节点为 R0 只读。保存、发布、改价等节点在补齐人工审批、补偿和写后验证前仍保持禁用。
- Doudian Node 与示例 Workflow 当前使用 `1.2.0`；Extension 继续报告旧 Node `1.0.0`、`1.1.0`，不覆盖已发布资产。
- 当前 Browser Protocol 尚未对第三方发布；这轮新增字段在本地 v1 冻结前纳入 `1.0.0`。首次对外兼容冻结后，任何新增字段都必须提升 Schema Minor 并保留兼容矩阵。
