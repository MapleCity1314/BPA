---
title: 消息参考
description: Browser Protocol v2 的页面观察、探测、命令和证据消息语义。
---

v2 使用严格消息联合。Gateway → Bridge 与 Bridge → Gateway 使用独立序列空间；同一方向的非重复消息必须严格大于已接受序号。

## Session 与能力

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `session.hello` | Bridge → Gateway | 发起新会话或携带恢复信息 |
| `session.welcome` | Gateway → Bridge | 选择协议、下发公钥与 Resume Token |
| `session.resume` | Gateway → Bridge | 告知恢复是否接受及重放起点 |
| `capability.report` | Bridge → Gateway | 声明节点、版本、风险和权限 |
| `session.error` | Gateway → Bridge | 返回协议或会话级错误 |

新会话固定使用 `session_id: "new"` 与 `seq: 0`。恢复请求携带上次 `resume_token` 和 `last_acked_command_seq`。

## 页面观察与主动探测

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `page.observation` | Bridge → Gateway | 上报标签页通用事实、认证上下文摘要、revision 与 page epoch |
| `page.probe.request` | Gateway → Bridge | 请求对确切标签页执行短时探测 |
| `page.probe.result` | Bridge → Gateway | 返回探测是否完成以及对应 observation revision |

页面观察不是 Workflow 的期望值。只有 Adapter observer 实际读取到的事实才能上报；
重复的同语义 ready 只刷新观察时间，导航、文档替换或认证上下文变化才推进 epoch。

## Command 与结果

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `command.dispatch` | Gateway → Bridge | 下发节点、输入、权限和执行边界 |
| `command.ack` | Bridge → Gateway | 确认是否接收 Command |
| `command.result` | Bridge → Gateway | 返回最终状态、输出和 Evidence 引用 |
| `result.ack` | Gateway → Bridge | 确认 Result 已接受 |

Result 状态只能是：

```text
succeeded | rejected | failed | timed_out | cancelled | uncertain
```

`uncertain` 表示系统无法证明写动作是否生效。它是需要人工核验的终态，不是可安全重试的普通失败。

## Cancel 与心跳

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `cancel.request` | Gateway → Bridge | 表达停止意图 |
| `cancel.ack` | Bridge → Gateway | 确认收到 Cancel 并说明动作是否开始 |
| `cancel.effective` | Bridge → Gateway | 返回 `cancelled` 或 `uncertain` |
| `heartbeat.ping` | Gateway → Bridge | 探测连接 |
| `heartbeat.pong` | Bridge → Gateway | 回应相同 nonce，并报告严格有界的 Extension 常驻资源占用 |

Cancel 不是回滚。写动作已经开始且无法确认副作用时必须返回 `uncertain`。

`heartbeat.pong.resource_usage` 只包含白名单计数：活跃命令、标签页命令、Alliance stage、
取消请求与停止屏障、观察标签页、受管标签页，以及 pacing reservation 和 probe generation
的当前数量、容量和 TTL。Core 必须校验固定容量及计数守恒；畸形或过界心跳不能成为资源曲线证据。

## Evidence

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `evidence.begin` | Bridge → Gateway | 声明 Evidence 元数据和分块信息 |
| `evidence.chunk` | Bridge → Gateway | 发送一个 Base64 数据块 |
| `evidence.complete` | Bridge → Gateway | 声明全部块已发送 |
| `evidence.ack` | Gateway → Bridge | 确认接收或要求从指定块继续 |

原始块大小为 256 KiB。每个块和完整 Evidence 都使用 SHA-256 校验。

完整字段与示例见[规范消息样例](../../../reference/examples/)。
