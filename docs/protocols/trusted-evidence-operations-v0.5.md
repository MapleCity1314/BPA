# BPA 可信证据与资源绑定协议候选 v0.5

状态：已接受（2026-07-30 人工确认）

日期：2026-07-30

## 1. 冻结目标

本候选只定义 BPA 0.4 后续实现共同依赖的公共语义：

- Source、Asset、Evidence 之间的不可变引用关系。
- Browser Evidence v1 从分块上传到 Runtime EvidenceRef 的提升条件。
- Control Hello 协商和应用帧边界。
- Node、Workflow 与 Run 之间的 Browser Resource Binding。
- 编译进 Adapter 的页面就绪条件。

它不开放浏览器写操作，不改变 IR2 执行身份、Assistance 授权边界或
`bpa.browser/2@2.0.0` 的页面观察、定向绑定和 Wire Schema。

## 2. Source、Asset 与 Evidence

三类对象职责固定：

```text
SourceRecord
  └─ 说明事实或文件来自哪里、何时取得、按什么权限和 Adapter 版本取得

AssetRecord
  └─ 说明一个不可变 Blob 的摘要、媒体属性、存储引用和派生关系

Evidence v1
  └─ 说明某次 Node Execution 使用或产生的可验证正文
```

`EvidenceLink` 只建立不可变引用，不复制 Source、Asset 或 Evidence 正文。链接至少
固定 Run、Node Execution、Evidence、至少一个 Source、关系类型和创建时间。调用方
不能通过更新 Link 改写已经完成的 Evidence；需要修正时创建新对象和新 Link。

平台页面和第三方估算 Source 必须保存 `accessScope`、`recordedAt`、原始观察摘要，
以及精确 Adapter ID、版本和摘要。会员不可见或认证失败是显式可用性结果，不能通过
缺省字段伪装成零值。

所有 Blob 使用 SHA-256 内容寻址。`storage_ref` 是 Core 产生的不透明引用，不接受
调用方指定的绝对路径、相对路径或 URL。SQLite 只保存元数据和引用，不保存大型
Blob。

默认操作限额：

- 单对象 25 MiB。
- 单 Run 2 GiB。
- 本地总量 10 GiB 时进入告警，不静默清理。
- Browser Evidence Chunk 原始正文最多 256 KiB。
- restricted/confidential DOM、截图默认 24 小时到期。
- 未引用的 public/internal 研究资产默认 30 天到期。
- 被 active ReferenceAssetPack 引用的 Asset 不得由保留任务删除。

Schema 固定可用的保留策略形状；发布验证器还必须拒绝
confidential/restricted Asset 使用 `public_30d`，以及 public Asset 使用
`restricted_24h`。时间顺序、引用存在性和保留策略与分类的一致性属于跨对象验证，
不能只依赖单对象 JSON Schema。

## 3. Browser Evidence 激活语义

发送顺序固定：

```text
evidence.begin
→ evidence.chunk × N
→ evidence.complete
→ evidence.ack(accepted=true)
→ command.result(evidence_refs)
→ result.ack
```

`evidence.begin` 在接收时绑定：

- 当前 Browser Session。
- `run_id`。
- `node_execution_id`。
- 当前 Command 的 `fencing_token`。
- Evidence ID、种类、媒体类型、总大小、块数和完整摘要。

接收规则：

- 第一个未持久化块的索引必须等于 `next_chunk_index`。
- 完全相同的已持久化块可以幂等重放。
- 相同 Evidence ID 出现不同元数据、块正文或摘要时拒绝。
- 旧 Session、旧 Fencing Token、错误 Run/Execution 和超限输入拒绝。
- `evidence.complete` 只有在块数、逐块摘要、总大小和完整摘要全部一致时成功。
- ACK 只表示 Blob 与 Evidence Metadata 已持久化，不表示 Workflow 已推进。

Core 重启后根据已持久化状态返回下一个块索引。Extension 在完整 ACK 前保留 Blob；
在 Result ACK 前保留 Result。

`command.result` 中的每个 Evidence ID 必须已经完成、属于同一个 Run 与 Node
Execution，并与当前 Fencing Token 一致。存在未完成引用时 Result 不进入 Engine，
也不能被当作无 Evidence 的成功结果。

Gateway 只把完整记录提升为带 Evidence ID、Digest 和 Classification 的
Runtime EvidenceRef。Node Outcome、Execution Event、Evidence Link 和状态推进使用
同一个 UoW。

Evidence v1 与 Runtime 的分类映射固定为：

```text
public       → public
internal     → internal
confidential → sensitive
restricted   → sensitive
```

Evidence Metadata 保留原始分类；Runtime 的 `sensitive` 只是收敛后的权限等级，不能
反向覆盖原始分类。

## 4. Control Hello

每个新客户端在发送应用请求前先发送小型 `bpa.control/hello/1` 协商信封：

```json
{
  "version": "bpa.control/hello/1",
  "kind": "hello",
  "requestId": "hello-01",
  "supportedApplicationProtocols": ["bpa.control/1"],
  "runtime": { "name": "bpa-cli", "version": "0.4.0" },
  "maxFrameBytes": 524288,
  "features": ["evidence_refs", "resource_bindings"]
}
```

Server 按自身优先级选择第一个公共应用协议，帧上限取双方较小值，功能位取交集。
成功响应使用 `welcome`；失败使用 `error`，错误码只允许
`MALFORMED_HELLO`、`NO_COMMON_APPLICATION_PROTOCOL` 或
`FRAME_LIMIT_TOO_SMALL`，并固定 `connection: "close"`。无法信任请求 ID 时返回
`requestId: null`。

协商信封自身不得携带业务参数或大型能力清单。成功后继续使用
`bpa.control/1`；本候选不重命名应用协议。

控制帧硬上限为 512 KiB。Server 对超大或畸形帧只终止当前连接并写入受限诊断，
不得终止 Core 进程。控制面不提供 Blob 降级通道；Dataset、图片和其他文件必须经
Core 发放的 Staging Lease 或 Browser Evidence Transport 进入。

旧客户端兼容由 Server 的显式 legacy adapter 决定。新客户端不能在协商失败后猜测
Server 能力并发送大型应用帧。

## 5. Browser Resource Binding

Node 新版本可以声明一个或多个 Browser Resource Requirement。每个 Requirement
固定：

- 本地唯一 key。
- 所需能力。
- 允许 Origin。
- 最低认证等级：anonymous、optional、authenticated 或 membership。
- 面向用户的用途说明。

精确映射形态为：

```yaml
# Node bpa/v1alpha2
resources:
  page:
    kind: browser
    capabilities: [browser.dom.read]
    allowedOrigins: [https://www.chanmama.com]
    authentication: membership
    purpose: Read metrics visible to the authenticated operator.

# Workflow bpa/v1alpha3
spec:
  resourceSlots:
    metrics_source:
      kind: browser
      capabilities: [browser.dom.read]
      allowedOrigins: [https://www.chanmama.com]
      authentication: membership
      purpose: Supply the metrics browser session.
  root:
    kind: sequence
    steps:
      - key: read_metrics
        kind: call
        use: chanmama.product.metrics.read@1.0.0
        resourceMappings:
          page: metrics_source
```

只有 Browser Node 可以声明 `resources`，并且 Browser Node v1alpha2 必须声明。
Schema 负责局部形状与上限；Compiler 负责验证映射存在、能力包含、Origin 不扩张和
认证等级不降级。

Workflow 将 Node Requirement 映射到命名 Resource Slot。Slot 不是普通 Workflow
input，不能通过 `${input...}`、页面内容或 Node 输出构造。

创建 Run 时，调用方为每个 Slot 提交精确 Browser Session。Core 验证后原子冻结：

- Slot 与 Requirement。
- Session ID。
- Capability Manifest Digest。
- Origin 范围。
- 认证等级。
- 绑定时间和批准主体。

IR2 继续使用 `bpa.workflow-ir/2`。Call 只保存 Slot key 和冻结 Binding Snapshot
引用，不把可变 Session 状态写入 Workflow Source。

Browser Provider 每次派发前重新验证 Session、能力、Origin 和认证状态。认证失效
创建 `auth_takeover` AssistanceTask，并在原 Checkpoint 暂停；不得静默切换到另一
Session。恢复后仍使用同一个 Slot，若需换 Session 必须形成新的、可审计的 Binding
revision。

旧 Node v1alpha1 和 Workflow v1alpha1/v1alpha2 没有 Resource Requirement，行为
保持不变。

## 6. Page Readiness

Page Readiness Contract 是 Adapter 发布闭包的一部分，不是 Workflow selector。
它只允许受限的语义信号：

- 目标语义元素已经出现。
- DOM 在指定窗口保持安静。
- 网络在指定窗口保持安静。
- 发现的资产数量连续多次稳定。

Contract 固定总超时、采样间隔、稳定窗口、最大刷新次数以及成功所需的组合关系。
所有时间和计数都有有限上限。

Contract 不允许 CSS selector、XPath、屏幕坐标、任意 JavaScript、网络请求正文或
从页面文本生成的新条件。语义元素必须引用已发布 PageModel/ElementContract，由
精确 Adapter 版本解析。

第一次扫描得到零个资产只能是一个样本，不能单独证明页面没有资产。超时结果必须
区分：

- 页面稳定且确实为空。
- 页面没有达到就绪条件。
- 认证或权限阻塞。
- Adapter 结构异常。

## 7. 确认边界

确认本候选后才允许实现：

- SQLite v7/v8 Migration。
- Evidence 分块持久化与 Result 提升。
- Control Server Hello。
- Node/Workflow Resource Binding 编译与运行。
- Page Readiness Adapter Runtime。
- Console、蝉妈妈和抖音采集节点。

任何需要改变以下内容的实现必须形成新的 ADR 或协议版本：

- Browser Evidence 的所有权和 ACK 含义。
- Control 帧边界或协商降级规则。
- Resource Slot 是否能被页面内容选择。
- IR2 执行身份。
- R2+ 人工授权边界。
- Source/Asset/Evidence 的不可变与删除规则。
