# BPA Browser Protocol v1

> 状态：已确认 v1（2026-07-27）
> 协议族：`bpa.browser/1`
> Schema：[`browser-protocol-v1.schema.json`](../../packages/schemas/schema/browser-protocol-v1.schema.json)
> 规范样例：[`browser-protocol-v1.messages.json`](examples/browser-protocol-v1.messages.json)

## 1. 边界

协议连接 Browser Gateway 与 Extension Bridge。v1 首个 Transport 是 Chrome Native Messaging；Workflow、Node 和执行语义不依赖 Transport。

Native Host 只负责：

- 校验 Chrome 传入的精确 Extension Origin。
- Chrome stdio framing。
- 将完整协议消息转发到 Local Core 的受限 Unix Socket。

Native Host 不解释 Workflow，不执行 Node，也不修改消息中的权限或业务参数。

## 2. 信封与限制

每条消息固定包含：

```text
protocol       bpa.browser/1
version        1.0.0
message_id     全局唯一；完全相同的 ID 视为重复投递
session_id     hello 使用 new，其余使用已建立 Session
seq            每个方向单调递增
sent_at        RFC 3339 UTC 时间
type           消息类型
trace_id       仅关联追踪，不承载业务数据
payload        按 type 严格校验
```

规则：

- 应用消息上限 512 KiB。
- 未知字段一律拒绝。
- 相同 `message_id` 返回已有处理结果，不重复产生副作用。
- Gateway→Bridge 与 Bridge→Gateway 分别维护独立的单调递增 `seq`；非重复消息必须严格大于该方向已接受序号。
- Session、Extension ID、协议版本或 Fencing Token 不匹配时拒绝。
- 普通 Result 不允许内嵌完整 DOM、截图或文件。

### 2.1 Timing 与 Risk 扩展

- `command.dispatch.payload.timing_policy` 携带已由 Compiler 解析的有界 TimingPolicy。
- `command.result.payload.risk_signals` 携带 Bridge/Adapter 检测到的结构化风险。
- `command.result.payload.timing_observation` 携带实际限速与页面稳定等待，供 Event 审计。
- TimingPolicy 不授权任何新动作，也不能扩大 Permission Grant。
- Blocking RiskSignal 必须停止当前动作并返回 `rejected`；不得尝试绕过验证码、登录或平台风控。
- 详细语义见 [`timing-and-risk-policy-v1.md`](../timing-and-risk-policy-v1.md)。

## 3. Session 状态机

```text
DISCONNECTED
  ↓ Native Port connected
HELLO_REQUIRED
  ↓ session.hello
NEGOTIATING
  ├─ incompatible → session.error(fatal) → CLOSED
  └─ session.welcome
       ↓
CAPABILITY_REQUIRED
  ↓ capability.report
READY
  ├─ heartbeat timeout → DISCONNECTED
  ├─ Native Port close → DISCONNECTED
  ├─ capability change → capability.report → READY
  └─ resume accepted → READY
```

恢复：

1. Bridge 使用上次 `resume_token` 和 `last_acked_command_seq` 发送 Hello。
2. Gateway 决定是否接受 Resume。
3. Resume Token 最长有效 24 小时，恢复成功后立即轮换；设备撤销时同步失效。
4. Gateway 从未确认的 Command Sequence 开始重放。
5. Bridge 先查询 Pending Result；已有结果则补发，不重新执行 Node。

## 4. Permission Grant

- Command 内嵌当前节点的完整最小权限快照，Bridge 不接受 Content Script 自报权限。
- Core 为 Grant 正文生成规范化 JSON，计算 SHA-256 `grant_digest`，再用 Ed25519 私钥生成 `authorization_tag`。
- `session.welcome` 下发当前 Core 公钥、算法和 `key_id`。Bridge 必须同时验证摘要、签名、有效期、域名、Node 风险等级和 Command 绑定。
- Core 私钥只保存在权限为 `0600` 的本地数据目录；扩展只获得公钥。
- 权限正文或签名字段发生任意变化都必须拒绝，不允许降级为“仅引用可信”。

## 5. Command 状态机

```text
QUEUED
  ↓ command.dispatch
DELIVERED
  ├─ command.ack(accepted=false) → REJECTED
  └─ command.ack(accepted=true)
       ↓
ACCEPTED
  ↓ local policy + page validation
EXECUTING
  ├─ command.result(succeeded|failed|rejected|timed_out|uncertain)
  │    ↓
  │  RESULT_PENDING_ACK
  │    ↓ result.ack(accepted=true)
  │  TERMINAL
  └─ disconnect → Bridge Outbox 保留 Result 或恢复执行状态
```

`command.ack` 只表示接收。Bridge 必须先持久化 Result，再发送；收到 `result.ack(accepted=true)` 后才能删除正文。

Command 在执行前还必须经过 Deadline、限速预约、活动 Tab/URL 复核和页面稳定性检查。等待会越过 Deadline 或页面上下文变化时，不得继续执行。

## 6. Cancel 与 Fencing

```text
cancel.request
→ cancel.ack
→ cancel.effective(cancelled | uncertain)
```

- Cancel 是停止意图，不是回滚。
- 动作尚未开始且到达安全停止点时可以 `cancelled`。
- 写动作已经开始且无法确认副作用时必须 `uncertain`。
- Command、ACK、Result 和 Cancel 都与当前 `fencing_token` 绑定。
- 旧 Token 的结果保留为审计记录，但不能推进 Workflow。

## 7. Evidence

Evidence 使用：

```text
evidence.begin
→ evidence.chunk × N
→ evidence.complete
→ evidence.ack
```

- 原始块为 256 KiB；Base64 后仍低于应用消息上限。
- 每块和完整 Evidence 都校验 SHA-256。
- Evidence Metadata 与正文分开保存。
- Bridge 在完整 ACK 前保留本地 Blob；ACK 后按保留策略清理。
- 首个只读 Workflow 不上传截图或完整 DOM。

## 8. 兼容策略

- `protocol` 表示不兼容的协议族和 Major。
- `version` 是该 Major 内的完整 Schema 版本。
- v1 对未知字段严格失败，不以猜测方式兼容。
- 添加消息或字段需要发布新的完整 Schema 版本并经过双端兼容测试。
- 删除字段、改变含义或放宽安全约束必须升级 Major。

## 9. 已确认决策

1. 新建会话固定使用 `session_id: "new"` 与 Hello `seq: 0`。
2. 两个方向使用独立序列空间。
3. Resume Token 最长 24 小时、成功恢复即轮换、设备撤销即失效。
4. Command 内嵌由 Core Ed25519 签名的完整 Permission Grant。
5. Evidence Chunk 保留在 v1；首个只读 Workflow 不使用。
