# Bridge / Gateway 实验报告 v0.1

> 日期：2026-07-27
> 状态：实验完成，等待进入正式通用协议设计。
> 注意：`bpa-bridge-experiment/0` 是实验消息格式，不是正式协议。

## 1. 实验目标

验证以下路径是否可以作为 BPA 浏览器执行架构的基础：

```text
Workflow Engine / Gateway
→ WebSocket
→ Chrome MV3 Extension Bridge
→ Extension Service Worker
→ Content Script
→ 平台适配器
→ 真实页面 DOM
```

重点验证：

- Gateway 能否识别浏览器实例。
- Bridge 能否报告节点能力和版本。
- Gateway 能否下发受约束节点。
- Bridge 能否把节点交给现有扩展能力执行。
- ACK 丢失和重复消息是否会导致重复执行。
- Gateway 或 Bridge 断线后能否恢复。
- 无法判断执行结果时是否可以进入 `uncertain`，阻止危险重试。
- 实验接入是否会破坏现有重点项插件。

## 2. 实验代码

### BPA 实验工程

位置：

```text
experiments/bridge-gateway/
```

包括：

- 实验消息 Schema。
- Gateway。
- Bridge 模拟器。
- 内存状态存储。
- JSON 文件状态存储。
- 演示程序。
- 可靠性测试。

### 重点项插件接入

新增：

```text
src/core/bridge/experimental.ts
tests/e2e/bridge.spec.ts
```

修改：

```text
entrypoints/background.ts
```

实验 Bridge 默认关闭，只有浏览器本地存储中存在显式实验配置时才连接 Gateway。

## 3. 已打通的节点

### `experiment.extension.status@1.0.0`

读取：

- 扩展版本。
- 自动填空能力。
- 包装预览能力。
- 是否只允许人工复核。
- 自动保存和自动发布是否关闭。

该节点验证了：

```text
Gateway
→ Bridge
→ Extension Service Worker
→ Result
```

### `doudian.shop.context.read@1.0.0`

读取：

- 当前抖店列表标签页。
- 页面 URL。
- 店铺名称。
- 稳定店铺 ID。
- 页面是否受支持。

该节点验证了完整路径：

```text
Gateway
→ Bridge
→ Extension Service Worker
→ tabs.sendMessage
→ list.content.ts
→ doudian.ts
→ DOM
→ Result
```

## 4. 已验证的可靠性语义

### 4.1 配对

Bridge 首次消息必须包含：

- 浏览器实例 ID。
- 配对令牌。
- 扩展版本。
- 节点能力。
- 最近确认序号。
- 尚未确认的结果。

配对令牌错误时 Gateway 拒绝会话。

### 4.2 能力协商

Gateway 只能调度 Bridge 明确报告的：

```text
node_id + node_version
```

未报告的节点版本会在 Gateway 侧被拒绝，不会发送给扩展。

### 4.3 Command ACK

Bridge 收到节点命令后先返回接收 ACK，再执行节点。

ACK 表示 Bridge 接受了命令，不表示业务成功。

### 4.4 Result ACK

Bridge 执行后：

1. 先把结果写入本地 Pending Results。
2. 再发送结果。
3. 收到 Gateway Result ACK 后才删除本地结果。

### 4.5 ACK 丢失与重复上报

实验主动延迟 Result ACK，并在 ACK 到达前断开 Bridge。

结果：

- Bridge 重连后补发结果。
- Gateway 根据 `nodeExecutionId` 和 `idempotencyKey` 去重。
- 节点只执行一次。
- Gateway 再次返回 Result ACK。
- Bridge 清除 Pending Result。

### 4.6 Gateway 进程重启

Gateway 将以下状态持久化为 JSON：

- 下一个 Command Sequence。
- 所有 Command。
- Command 当前状态。
- 终态 Result。
- Idempotency Key。

实验在节点已经接收但尚未完成时关闭 Gateway，随后使用同一状态文件启动新 Gateway。

结果：

- Gateway 恢复未完成命令。
- Bridge 重新连接。
- Bridge 补发已完成但未确认的结果。
- 节点没有重复执行。

### 4.7 `uncertain`

实验保留 `uncertain` 作为终态：

```text
动作可能已经发生
但系统无法验证最终业务状态
```

同一个 Idempotency Key 一旦出现 `uncertain`，Gateway 不允许直接重新调度。

后续必须：

- 重新观察业务状态。
- 运行专用验证节点。
- 或请求人工接管。

## 5. 实验消息

实验信封包含：

```text
protocol
messageId
sentAt
type
payload
```

实验 Command 包含：

```text
commandSeq
nodeExecutionId
idempotencyKey
node.id
node.version
input
leaseMs
```

实验期间证明这些字段有必要，但正式协议仍需补充：

- `runId`
- `workflowId`
- `workflowVersion`
- `browserInstanceId`
- `sessionId`
- `tabRef`
- `pageEpoch`
- `attempt`
- `permissionGrant`
- `approvalToken`
- `deadline`
- `traceId`
- Evidence 引用
- 协议兼容范围

## 6. 对现有插件的影响

实验 Bridge：

- 默认关闭。
- 不新增界面入口。
- 不改变现有扫描 Workflow。
- 不改变原有运行消息。
- 只暴露两个只读实验节点。
- 不开放保存、发布和自动填写节点。

现有插件验证结果：

```text
TypeScript：通过
Unit Tests：12 files / 51 tests 通过
Production Build：通过
Playwright E2E：2 tests 通过
```

其中一个 E2E 是原有结果中心回归测试，另一个是新增 Bridge/Gateway 完整链路测试。

## 7. BPA 实验工程验证结果

```text
TypeScript：通过
Build：通过
Unit Tests：1 file / 5 tests 通过
Demo：通过
```

五项测试覆盖：

1. 配对、能力协商和节点结果。
2. 缺失节点版本拒绝。
3. ACK 丢失、重连、结果补发和去重。
4. `uncertain` 防止重复执行。
5. Gateway 进程重启恢复。

## 8. 实验结论

### 已确认

- Loopback WebSocket 足以完成第一阶段 BPA 通信。
- Chrome MV3 Service Worker 可以承担 Bridge。
- 必要状态必须保存在浏览器存储，而不是全局变量。
- Gateway 必须持久化命令和终态结果。
- 节点能力必须在连接时协商。
- Command ACK 和 Result ACK 必须分离。
- Result 必须先落本地 Outbox，再等待 ACK。
- `uncertain` 必须是一等执行结果。
- Engine 不需要直接访问 DOM。
- 现有重点项插件的专用能力可以作为粗粒度节点直接接入。

### 尚未正式决定

- 正式设备身份与密钥方案。
- WebSocket 和 Native Messaging 的长期选择。
- Gateway 部署在本地还是公司服务端。
- 正式 Page Epoch 算法。
- Tab Lease 和并发所有权。
- Approval Token 的签发和验证。
- Evidence 的存储位置与大小限制。
- 协议升级和兼容策略。
- 命令取消和超时后的最终一致性。

## 9. 正式协议前的决策点

实验已经足以进入正式通用协议设计。正式编写前，需要确认以下方向：

1. 第一版协议只支持本地 Gateway，还是同时支持远程 Gateway。
2. 第一版是否把 Native Messaging 纳入规范，还是仅定义可替换 Transport。
3. 设备身份是公司账号绑定、设备证书，还是一次性配对后本地密钥。
4. 正式协议是否从第一版就包含高风险审批凭证。
5. Evidence 是协议内嵌，还是只传引用。
6. Workflow Engine 与 Gateway 是同一服务，还是从第一版就独立部署。

## 10. 建议

第一版正式协议建议：

- Transport Neutral。
- 优先实现 Loopback WebSocket。
- Engine 与 Gateway 逻辑分层、物理同进程。
- 从第一版包含 Permission Grant 和 Approval Token 字段。
- Evidence 默认传引用，小型证据允许内嵌。
- 把 Page Epoch、Idempotency 和 `uncertain` 定为核心语义。
- Native Messaging 作为第二个 Transport Adapter，不阻塞第一版。
