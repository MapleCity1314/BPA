---
title: Browser Protocol v2
description: Gateway、Native Host 与 Extension Bridge 之间的消息边界和完整生命周期。
---

**状态：已确认 v2，页面观察与定向绑定已启用**
协议族：`bpa.browser/2`
Schema 版本：`2.0.0`

Browser Protocol v2 连接 Browser Gateway 与 Extension Bridge。首个 Transport 是 Chrome Native Messaging，但 Workflow、Node 和执行语义不依赖具体 Transport。

## 组件边界

### Browser Gateway

- 建立与恢复 Session。
- 调度经过编译和授权的 Command。
- 维护 Gateway → Bridge 的单调序列。
- 接收结果、证据和风险信号。

### Native Host

- 校验 Chrome 传入的精确 Extension Origin。
- 处理 Chrome stdio framing。
- 将完整消息转发到受限的 Local Core 端点。

Native Host 不解释 Workflow，不执行 Node，也不修改权限或业务参数。

### Extension Bridge

- 维护 Bridge → Gateway 的单调序列。
- 校验 Session、Permission Grant、Fencing Token 与页面上下文。
- 调用已经注册的浏览器能力。
- 先持久化 Result，再等待 Gateway 确认。

## 固定信封

每条消息都包含：

| 字段 | 含义 |
| --- | --- |
| `protocol` | 固定为 `bpa.browser/2` |
| `version` | 当前 Schema 版本 `2.0.0` |
| `message_id` | 全局唯一；相同 ID 表示重复投递 |
| `session_id` | 新会话使用 `new`，其余使用已建立 Session |
| `seq` | 每个方向独立、单调递增 |
| `sent_at` | RFC 3339 UTC 时间 |
| `type` | 消息类型 |
| `trace_id` | 仅用于关联追踪 |
| `payload` | 按 `type` 严格校验 |

应用消息上限为 512 KiB。未知字段一律拒绝；普通 Result 不允许内嵌完整 DOM、截图或文件。

## Session 生命周期

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

Resume Token 最长有效 24 小时。恢复成功后立即轮换，设备撤销时同步失效。Gateway 从未确认的 Command Sequence 开始重放。

恢复沿用稳定的 Browser Instance 身份并重新解析当前标签页。临时 Session ID 和 Tab ID
不能作为长期配置；旧 Binding 在重启或 page epoch 变化后进入 `needs_rebind`。

## 页面观察与资源绑定

Session 就绪不等于页面可执行。Content Script 加载、导航、SPA 路由、认证上下文变化和
标签页离开都会触发 Adapter observer 探测。Core 只看到通用页面事实和不可解析的认证
上下文摘要，并冻结 Browser Instance、Tab、Origin/path、capability、revision 与 page
epoch。命令只能发往这个确切标签页，不回退到当前活动标签页。

## Command 生命周期

```text
QUEUED
  ↓ command.dispatch
DELIVERED
  ├─ command.ack(accepted=false) → REJECTED
  └─ command.ack(accepted=true) → ACCEPTED
       ↓
EXECUTING
  ↓ command.result
RESULT_PENDING_ACK
  ↓ result.ack(accepted=true)
TERMINAL
```

`command.ack` 只表示接收。Bridge 必须先持久化 Result，再发送；收到 `result.ack` 后才能删除正文。

如果 Result 引用 Evidence，完整顺序还包括：

```text
evidence.begin → chunk → complete → evidence.ack
→ command.result(evidence_refs) → result.ack
```

未完整、跨 Run、跨 Node Execution 或旧 Fencing Token 的 Evidence 不能推进 Engine。

继续阅读：[消息参考](./messages/) · [安全边界](./security/) · [Timing 与 Risk](./timing-and-risk/)
