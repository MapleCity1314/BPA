# BPA 通用技术方案 v1.0

> 文档类别：正式规范。当前实现细节仍以 Schema、ADR 与当前实况为准。

> 文档状态：架构方案
> 日期：2026-07-27
> 当前阶段：单场景验证成功，准备从专用解决方案提炼通用平台
> 本文范围：定义安全、可扩展、可升级、灵活的总体架构，不展开核心代码实现和正式协议字段细节
> 文档权威性：本文是当前架构基线；早期 `v0.1` 文档仅保留讨论过程，不再作为实现依据

## 1. 文档目的

本方案回答以下问题：

1. 已经成功运行的“抖店重点项检查器”原链路是什么。
2. 哪些能力应该保留为平台核心，哪些应该拆成通用节点或平台节点。
3. BPA 通用架构应该如何分层。
4. `workflow_gen`、`node_gen`、Workflow、Node、Adapter、Bridge 和 Gateway 如何协作。
5. 页面变化、浏览器断线、登录验证、AI 不可用和升级失败时如何兜底。
6. 如何建立权限、安全、审计、版本和回滚机制。
7. 第一阶段采用什么技术栈。
8. 仓库和模块应该如何组织。

本文不是核心技术实现说明，不包含：

- 最终 Browser Protocol 的完整字段定义。
- Workflow Compiler 的具体算法。
- DOM 语义化和元素匹配算法细节。
- 调度器、数据库和扩展的完整代码。
- 所有平台的通用适配承诺。

## 2. BPA 的目标定位

BPA 是面向真实浏览器业务流程的协作与执行体系。

它将经过验证的浏览器业务能力沉淀为：

```text
版本化 Workflow
+ 版本化 Node
+ 受控浏览器执行
+ 可恢复运行状态
+ 权限与人工治理
+ 可验证证据
```

人和 AI 都可以触发同一套 Workflow，但：

- AI 不直接操作浏览器。
- AI 不生成代码后立即执行。
- 浏览器扩展不自行决定完整业务流程。
- Workflow Engine 不直接读取或修改 DOM。
- 页面内容不具有指挥系统的权限。

### 2.1 设计目标

- **安全**：动作、数据、页面、域名、店铺和审批均有边界。
- **确定性**：稳定步骤由 Workflow 和 Node 执行，不依赖模型临场发挥。
- **可恢复**：浏览器、扩展、Gateway 或 Engine 中断后可以恢复或明确停止。
- **可验证**：关键动作必须有后置条件和证据。
- **可扩展**：支持通用节点、组合节点和平台自定义节点。
- **可升级**：Workflow、Node、Adapter、协议和扩展均可独立版本化和回滚。
- **灵活**：支持纯本地、混合和集中式部署。
- **公司持有**：正式能力独立于聊天、模型和个人账号存在。

### 2.2 非目标

第一阶段不追求：

- 万能浏览器 Agent。
- 所有网站零适配运行。
- 绕过验证码和平台风控。
- 完全无人值守的云端浏览器。
- AI 自动批准高风险操作。
- 运行时自动生成并加载浏览器代码。
- 通过一个巨大提示词承载全部业务能力。

## 3. 已验证的原链路

当前“抖店重点项检查器”是 BPA 的第一个参考实现。

### 3.1 原业务链路

```text
用户打开抖店商品列表
        ↓
扩展发现店铺和当前筛选范围
        ↓
完整采集虚拟列表和多页商品
        ↓
校验采集数量与页面总数
        ↓
导入并固定包装主数据版本
        ↓
商品与主数据智能匹配
        ↓
包装类型规则推断
        ↓
生成包装预检
        ↓
用户确认预检范围
        ↓
依次打开商品编辑页
        ↓
等待页面和懒加载区域稳定
        ↓
临时切换目标包装
        ↓
等待动态食品安全字段稳定
        ↓
扫描必填字段与平台提醒
        ↓
还原原包装并验证
        ↓
保存问题、证据和审计
        ↓
结果中心处理异常
        ↓
可选：只填空值并交给人工复核保存
```

### 3.2 原技术链路

```text
Side Panel / Dashboard
        ↓
Chrome Runtime Message
        ↓
Extension Background Service Worker
        ├─ 任务状态
        ├─ 商品队列
        ├─ 标签页调度
        ├─ 重试和熔断
        └─ IndexedDB
        ↓
tabs.sendMessage
        ↓
List / Editor Content Script
        ↓
Doudian Adapter
        ↓
真实页面 DOM
```

### 3.3 原链路已经证明的能力

- 真实浏览器登录态可以用于稳定业务流程。
- Content Script 可以完成必要的 DOM 读取和有限修改。
- 虚拟列表、多页采集和动态字段需要平台级适配。
- “动作后验证”比“动作调用成功”更重要。
- 临时写操作必须有补偿和补偿验证。
- 登录验证和页面结构异常必须安全暂停。
- 预检可以在大批量操作前提供人工治理点。
- 队列、状态和审计必须持久化。
- 人工复核式填写可以在不自动保存、不自动发布的前提下提升效率。

### 3.4 原架构的限制

- Workflow 固化在 `background.ts` 中。
- 业务编排、浏览器调度和平台适配耦合。
- 节点没有独立注册、版本和权限契约。
- 扩展既是 Engine，又是 Gateway 和 Bridge。
- 运行状态以当前快照为主，缺少统一执行事件。
- 其他场景无法直接复用调度和治理能力。
- Codex 不能通过稳定工具生成或维护 Workflow。

## 4. 目标总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ 触发与创作层                                                  │
│ 人 / Codex / API / 定时任务                                   │
│ Workflow Studio / Workflow Skill / Node Skill                 │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│ 控制平面                                                      │
│ Workflow Registry     Node Catalog       Adapter Registry     │
│ Workflow Compiler     Policy Service     Release Manager      │
│ workflow_gen          node_gen           Review / Approval    │
└───────────────────────┬──────────────────────────────────────┘
                        │ Published Artifacts
┌───────────────────────▼──────────────────────────────────────┐
│ 运行平面                                                      │
│ Workflow Engine       Scheduler          Human Task Service   │
│ Node Runtime Host     Retry/Compensate   Event Log            │
│ Execution State       Lease/Fencing      Cancellation         │
└───────────────────────┬──────────────────────────────────────┘
                        │ Node Execution
┌───────────────────────▼──────────────────────────────────────┐
│ 浏览器接入层                                                  │
│ Browser Gateway       Session Registry   Capability Registry  │
│ Delivery / ACK        Idempotency         Evidence Receiver   │
└───────────────────────┬──────────────────────────────────────┘
                        │ BPA Browser Protocol
┌───────────────────────▼──────────────────────────────────────┐
│ 浏览器执行层                                                  │
│ Extension Bridge      Local Policy Guard Action Dispatcher    │
│ Browser Action Kernel Platform Adapters   Content Scripts     │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│ 用户真实浏览器、真实登录状态和真实页面 DOM                    │
└──────────────────────────────────────────────────────────────┘

所有层级 ──→ Event Store / Evidence Store / Audit / Observability
```

## 5. 架构分层

### 5.1 触发与创作层

提供四种入口：

- 人在界面中选择 Workflow 并填写参数。
- Codex 从自然语言中选择 Workflow 并补齐参数。
- 内部系统通过 API 发起任务。
- 定时任务或事件触发器发起任务。

无论入口如何，最终都必须转换为统一的结构化请求：

```text
workflow_id
workflow_version
parameters
execution_scope
requester
risk_context
```

AI 不可用时，人和 API 仍然可以调用相同 Workflow。

### 5.2 控制平面

负责定义和发布能力，不直接运行页面动作。

包括：

- Workflow Registry。
- Node Catalog。
- Adapter Registry。
- Compiler 与 Validator。
- 权限策略。
- 审批与发布。
- 版本、差异和回滚。
- `workflow_gen`。
- `node_gen`。

控制平面的产物是不可变、可审计的正式版本。

### 5.3 运行平面

负责运行已发布 Workflow：

- 固定 Workflow 和 Node 版本。
- 持久化执行状态。
- 调度节点。
- 处理条件、循环、并行和子流程。
- 管理超时、重试、补偿和人工任务。
- 保存追加式执行事件。
- 在异常时停止、恢复或转交人工。

运行平面不直接访问 Chrome API 和页面 DOM。

### 5.4 浏览器接入层

Browser Gateway 是 Engine 与浏览器之间的可信协调层。

职责：

- 管理浏览器实例和设备会话。
- 处理配对和设备身份。
- 接收 Bridge 能力报告。
- 将节点执行路由到正确浏览器。
- 提供 ACK、重发和去重。
- 管理标签页租约和并发所有权。
- 接收证据和执行结果。
- 拒绝不兼容节点或扩展版本。

Gateway 不执行 DOM 操作。

### 5.5 浏览器执行层

Extension Bridge 运行在 Chrome 扩展中。

职责：

- 与 Gateway 建立受认证连接。
- 报告节点、Adapter 和动作能力。
- 接收当前节点命令。
- 本地再次校验权限、页面、域名和目标。
- 把命令交给 Action Kernel 或平台 Adapter。
- 先持久化结果，再回传 Gateway。
- 断线后补发尚未确认的结果。

浏览器扩展不保存完整正式 Workflow，也不决定下一个业务节点。

## 6. 核心资产模型

### 6.1 Workflow

Workflow 描述业务目标和执行关系：

- 输入与输出。
- 节点。
- 控制流。
- 数据流。
- 条件与分支。
- 重试和超时。
- 补偿。
- 人工确认。
- 风险等级。
- 验收标准。
- 使用的 Node 固定版本。

Workflow 是声明式资产，不能内嵌任意执行代码。

### 6.2 Node

Node 是稳定、可测试、可复用的执行能力。

每个 Node 必须声明：

- ID 与版本。
- 运行环境。
- 输入、输出和配置 Schema。
- 权限。
- 风险等级。
- 幂等语义。
- 超时和重试策略。
- 错误码。
- Evidence 要求。
- 支持的 Adapter 版本。

### 6.3 Adapter

Adapter 是平台页面结构和浏览器能力的适配实现。

例如：

```text
doudian-2026-07
chanmama-2026-07
juliang-qianchuan-2026-07
```

Adapter 负责：

- 页面识别。
- 语义目标定位。
- 平台专有控件。
- 页面就绪信号。
- 平台错误识别。
- 页面版本和兼容范围。

Adapter 不应该隐藏完整业务流程。

### 6.4 Skill

Skill 是 Codex 生成和维护资产时使用的方法说明：

- 如何采集 Workflow 需求。
- 如何选择节点。
- 如何补充测试和异常分支。
- 如何判断需要新 Node。
- 如何生成审核材料。

Skill 不是运行时执行能力。

### 6.5 Tool

Tool 是 Codex 可调用的确定性操作，例如：

- 查询 Node Catalog。
- 创建 Workflow 草稿。
- 校验 Workflow。
- 生成 Node 候选包。
- 运行模拟。
- 生成差异。
- 提交审核。

Codex 通过 Skill 学会方法，通过 Tool 操作正式资产。

## 7. 能力模型

### 7.1 通用控制能力

- `control.start`
- `control.succeed`
- `control.fail`
- `control.condition`
- `control.switch`
- `control.foreach`
- `control.parallel`
- `control.join`
- `control.wait`
- `control.retry`
- `control.compensate`
- `control.circuit_breaker`
- `control.subworkflow`

第一版限制：

- `foreach` 必须设置最大数量。
- 循环必须有明确终止条件。
- 并行度必须受 Workflow 和设备策略限制。
- 补偿动作必须独立记录结果。

### 7.2 通用浏览器能力

观察类：

- `browser.observe`
- `browser.extract.text`
- `browser.extract.table`
- `browser.assert.visible`
- `browser.assert.text`
- `browser.assert.value`
- `browser.assert.url`
- `browser.assert.download`

动作类：

- `browser.navigate`
- `browser.click`
- `browser.input`
- `browser.select`
- `browser.check`
- `browser.scroll`
- `browser.wait_for`
- `browser.switch_tab`
- `browser.download`
- `browser.form.fill`

动作和验证必须分开建模。组合节点可以提供便捷接口，但编译后仍要保留动作和验证语义。

### 7.3 通用数据能力

- `data.validate`
- `data.map`
- `data.filter`
- `data.merge`
- `data.pick`
- `data.csv.parse`
- `data.table.normalize`
- `data.record.match`
- `rule.evaluate`

复杂业务计算应成为注册节点，而不是无限扩张表达式语言。

### 7.4 通用人工能力

- `human.approve`
- `human.input`
- `human.review`
- `human.takeover`
- `human.reject`

人工节点需要：

- 责任人。
- 截止时间。
- 可见上下文。
- 风险说明。
- 批准或拒绝记录。
- 审批凭证。

### 7.5 系统与服务能力

- `http.request`
- `file.inspect`
- `file.save`
- `secret.get`
- `notification.send`
- `evidence.persist`

所有外部访问必须通过域名、凭证和数据范围白名单。

### 7.6 自定义能力

按照优先级分为：

1. **组合节点**：组合已有节点，不引入新代码。
2. **Engine Node**：通过 Node Runtime Host 运行的确定性代码。
3. **Browser Adapter Node**：随扩展发布的平台专有能力。

不允许 Workflow 动态下发 JavaScript、`eval` 或远程脚本。

### 7.7 Node Runtime Host

Node Runtime Host 是 Engine 与可执行 Node 代码之间的强制边界。Workflow Engine 只负责状态机、调度和领域事务，不直接加载未受信任 Node 包。

运行等级：

| 等级 | 运行方式 | 适用范围 |
|---|---|---|
| `builtin_trusted` | 可在 Engine Worker 进程内运行 | BPA 内置、签名、随核心版本发布的纯计算节点 |
| `team_isolated` | 独立进程、锁定模块加载器和 Capability IPC | 已审核的团队自定义 Node；提供故障隔离，不宣称可抵御同一 OS 用户下的恶意代码 |
| `untrusted_sandbox` | 容器、OS Sandbox 或独立低权限用户；默认无网络和宿主挂载 | 第三方 Node、来源不完全可信或高风险代码 |
| `browser_adapter` | 仅随签名扩展构建发布 | 需要 Chrome API 或 DOM 的平台能力 |

`team_isolated` 和 `untrusted_sandbox` 默认拒绝文件系统、网络、环境变量、子进程和动态代码加载。单独启动 Node.js 子进程只构成故障隔离，不构成恶意代码安全边界；需要安全隔离时必须使用操作系统级 Sandbox、容器或独立低权限身份。Node 只能通过声明式 Capability API 请求：

- 限定域名的 HTTP。
- Secret Handle 解析。
- 临时文件或对象存储引用。
- Evidence 写入。
- 受控通知。

Runtime 必须实施：

- CPU、内存、墙钟时间、输出大小和并发配额。
- 每次执行固定 Node 包摘要、权限清单和 Runtime 版本。
- 租户、公司与 Run 上下文隔离。
- 超时强制终止、人工 Kill Switch 和熔断。
- 输入输出 Schema 校验及结构化错误码。
- 不把 Secret 原文和宿主环境变量注入 Node。

Node 包必须经过构建、测试、人工审核、签名或摘要校验后才能进入 Published 状态。运行时只按内容摘要加载不可变发布物。

## 8. `workflow_gen` 与 `node_gen`

```text
业务需求
   ↓
workflow_gen
   ↓
查询 Node Catalog
   ├─ 能力完整 → 生成 Workflow 草稿
   └─ 能力缺失 → 创建 Node Requirement
                         ↓
                      node_gen
                         ↓
             候选节点 + 测试 + 权限说明
                         ↓
                  测试与人工审核
                         ↓
                    Node Catalog
                         ↓
              workflow_gen 重新生成
```

### 8.1 `workflow_gen`

输出：

- `workflow.yaml`
- `requirements.md`
- `tests/*.yaml`
- `risk-assessment.md`
- `generation-report.json`

必须执行：

- Schema 校验。
- 节点版本检查。
- 数据类型检查。
- 不可达路径检查。
- 写操作后置验证检查。
- 高风险审批点检查。
- Secret 和权限检查。

### 8.2 `node_gen`

输出：

- Node Definition。
- 实现骨架或组合定义。
- 契约测试。
- 页面夹具测试。
- 安全测试。
- Permission 声明。
- Changelog。
- Generation Report。

生成节点不能自动批准自己，也不能直接进入扩展运行环境。

## 9. Browser Bridge / Gateway

### 9.1 Bridge

内部模块：

```text
Extension Bridge
├── Transport Adapter
├── Session Manager
├── Capability Reporter
├── Action Dispatcher
├── Local Policy Guard
├── Result Outbox
└── Evidence Collector
```

Bridge 必须具备：

- 断线重连。
- Pending Result 本地持久化。
- 节点执行去重。
- 当前页面和标签页校验。
- 协议和能力版本协商。
- 本地拒绝越权动作。

### 9.2 Gateway

内部模块：

```text
Browser Gateway
├── Device Registry
├── Session Registry
├── Capability Registry
├── Command Router
├── Delivery Manager
├── Idempotency Store
├── Tab Lease Manager
├── Policy Enforcement
└── Evidence Receiver
```

Gateway 必须持久化：

- Command。
- Command 状态。
- Result。
- Idempotency Key。
- 浏览器会话摘要。
- 已签发权限。
- 审批凭证引用。

### 9.3 Transport

正式协议应与 Transport 解耦。

第一阶段实现：

```text
Extension → Loopback WebSocket → Local Gateway
```

后续可实现：

- Native Messaging。
- WSS Remote Gateway。
- 企业设备代理。

Transport 变化不应改变 Node、Workflow 和执行语义。

### 9.4 消息语义

正式协议至少需要：

- Session Hello / Resume。
- Capability Report。
- Command。
- Command ACK。
- Command Result。
- Result ACK。
- Heartbeat。
- Cancel。
- Evidence Upload。
- Session Error。

Command ACK 只表示接收，不表示业务完成。

Result 必须先进入 Bridge Outbox，收到 Result ACK 后才能删除。

### 9.5 Loopback 连接安全

Loopback WebSocket 不是天然可信边界。本机恶意页面、其他扩展和本地进程都可能尝试连接 Gateway。

第一阶段必须满足：

- Gateway 只绑定 `127.0.0.1`；如支持 IPv6，只额外绑定 `::1`。禁止监听 `0.0.0.0`、局域网地址或自动暴露端口。
- WebSocket 握手校验预先配置的 Extension Origin / Extension ID；浏览器不提供可信 Origin 时，改用 Native Messaging 或受保护的本地发现机制，不能直接放行。
- 安装时生成设备密钥；首次使用一次性 Pairing Code，短时有效、仅能消费一次。
- 每次会话采用 Challenge-Response，Session Token 短期有效并绑定设备、Extension ID、协议版本和权限快照。
- 每条消息包含 `session_id`、单调 `seq`、`timestamp` 和 `nonce`；Gateway 拒绝乱序越界、过期和重放消息。
- Token 支持轮换、主动吊销、设备登出和异常速率熔断。
- 端口发现文件、Native Host 配置或本地 IPC 元数据仅对当前 OS 用户可读，不通过网页或公共 HTTP 端点暴露。

随机端口只能降低扫描概率，不能替代身份认证。Browser Protocol v1 必须把配对、握手、重放窗口、轮换和吊销状态机写成正式协议。

### 9.6 Bridge 本地数据保护

Bridge Outbox 只保存恢复投递所需的最小数据：

- `command_id`、`node_execution_id`、结果状态、错误码。
- 经 Schema 约束的最小输出。
- Evidence 内容摘要和对象引用。
- 投递次数、创建时间与过期时间。

默认不在 Outbox 保存完整 DOM、Cookie、Secret、页面 HTML 或无关业务字段。必须保存的敏感 Evidence 进入独立存储，采用最小文件权限；操作系统或浏览器提供可靠能力时启用静态加密。

本地保护策略：

- 按数据分类设置 TTL 和硬容量上限，达到上限时停止接收新的高风险任务。
- Result ACK 后尽快删除 Outbox 正文，仅保留最小审计摘要。
- 设备登出、吊销和卸载流程清理 Session Token、待投递敏感数据和临时 Evidence。
- `chrome.storage` / IndexedDB 不被视为密钥保险箱；长期私钥优先交给 OS Keychain 或 Native Host。
- 不承诺浏览器本地存储可抵御已控制当前 OS 用户的恶意进程；企业高安全场景升级为 Native Messaging 与设备证书。

## 10. Workflow Engine

### 10.1 执行模型

建议使用“持久化状态机 + 追加式事件”：

```text
Workflow Definition
        ↓
Compiled Workflow IR
        ↓
Workflow Run
        ↓
Node Execution
        ↓
Execution Events
        ↓
Current State Projection
```

### 10.2 运行状态

Workflow Run：

```text
created
validated
queued
running
waiting_browser
waiting_human
paused
compensating
succeeded
failed
cancelled
uncertain
```

Node Execution：

```text
scheduled
dispatched
accepted
executing
succeeded
rejected
failed
timed_out
cancelled
uncertain
```

### 10.3 事件

核心事件：

```text
RUN_CREATED
RUN_STARTED
NODE_SCHEDULED
NODE_DISPATCHED
NODE_ACCEPTED
NODE_SUCCEEDED
NODE_FAILED
NODE_UNCERTAIN
COMPENSATION_STARTED
COMPENSATION_COMPLETED
HUMAN_TASK_CREATED
HUMAN_APPROVED
RUN_PAUSED
RUN_RESUMED
RUN_CANCEL_REQUESTED
NODE_CANCEL_REQUESTED
NODE_CANCEL_ACKNOWLEDGED
NODE_CANCEL_EFFECTIVE
LEASE_GRANTED
LEASE_TRANSFERRED
RUN_COMPLETED
```

事件不可原地修改。当前状态通过事件归约形成。

### 10.4 幂等

所有 Node Execution 都必须有 Idempotency Key。

幂等策略由节点声明：

- `pure`：纯计算，可以安全重试。
- `repeatable_read`：只读操作，可以重新执行。
- `verified_write`：写操作，重试前必须验证业务状态。
- `non_repeatable`：不可直接自动重试。

### 10.5 `uncertain`

`uncertain` 表示：

```text
动作可能已经发生
但系统无法确认最终业务状态
```

处理顺序：

1. 执行专用验证节点。
2. 重新观察页面或业务数据。
3. 进入补偿流程。
4. 请求人工确认。

`uncertain` 不能被普通 Retry 自动重试。

### 10.6 Lease、Fencing 与 Cancel

每个可被多 Worker、Gateway 或会话竞争的执行目标都使用带版本的 Lease：

```text
resource_id
owner_id
lease_expires_at
fencing_token       # 单调递增
```

每次签发、续期后的所有 Command 和 Result 都携带 `fencing_token`。存储层只接受当前 Token；旧持有者在暂停、网络分区或恢复后返回的结果必须保存为审计事件，但不得推进 Workflow 状态。Lease 过期不等于动作未发生，接管方必须先验证外部业务状态。

Cancel 是意图，不是回滚：

```text
cancel_requested
→ cancel_acknowledged
→ cancel_effective
```

- `cancel_requested`：Engine 已记录停止意图，不再调度新节点。
- `cancel_acknowledged`：执行端已收到请求，但动作可能已经开始。
- `cancel_effective`：执行端已到达安全停止点，且 Engine 已确认终态。

如果写动作已开始而最终副作用无法确认，Node 必须进入 `uncertain`，再按“验证 → 补偿 → 人工确认”处理；不得直接标记 `cancelled`。不能中断的外部 API 或页面提交必须在 Node Definition 中声明取消能力和安全停止点。

## 11. 兜底体系

### 11.1 页面加载缓慢

处理：

- 使用页面信号而不是只依赖固定时间。
- 按节点设置最大预算。
- 在预算内进行有限重试。
- 超时后返回结构化错误。
- 不把超时等同于页面改版。

### 11.2 元素找不到或不唯一

处理：

1. 重新观察页面。
2. 使用允许的语义恢复。
3. 检查 Page Epoch。
4. 仍不确定则停止并请求人工。

不能猜测并点击相似元素。

### 11.3 页面改版

处理：

- 单页面异常：重试和刷新。
- 连续结构异常：Adapter 熔断。
- 当前运行暂停。
- 保存 DOM 摘要和证据。
- 生成 Adapter 更新候选。
- 测试、审核和发布新版 Adapter。

### 11.4 登录、验证码和安全验证

处理：

- 识别验证页面。
- 立即暂停受影响的浏览器会话。
- 通知人工处理。
- 验证完成后重新确认页面、账号和店铺。
- 从安全检查点恢复。

不尝试自动绕过。

### 11.5 Bridge 断线

处理：

- Engine 进入 `waiting_browser`。
- Gateway 保留未完成 Command。
- Bridge 重连时报告 Pending Result。
- Gateway 去重并恢复。
- 写操作无法确认时进入 `uncertain`。

### 11.6 Gateway 重启

处理：

- Command 和 Result 持久化。
- 重启后恢复 Session Registry 摘要。
- 等待 Bridge 重新连接。
- 补发非终态 Command。
- 接收 Bridge Outbox 中的结果。

### 11.7 Engine 重启

处理：

- 从 Event Store 重建当前状态。
- 对已调度节点查询 Gateway。
- 对终态节点不重复调度。
- 对状态不一致节点进入恢复流程。

### 11.8 AI 不可用

处理：

- 已发布 Workflow 继续运行。
- 人可以直接选择 Workflow。
- 缺失参数由表单或规则补齐。
- 运行时不依赖 AI 的稳定步骤不受影响。
- 语义恢复失败时转人工，不退化为自由操作。

### 11.9 Node 缺失或版本不兼容

处理：

- 调度前进行 Capability Negotiation。
- 不兼容则不创建页面动作。
- 尝试兼容节点版本或其他浏览器实例。
- 无兼容执行端时暂停并提示升级。

### 11.10 补偿失败

处理：

- 立即停止当前对象的后续写操作。
- 保存动作前后证据。
- 关闭或隔离受影响标签页。
- 达到阈值后对店铺或 Workflow 熔断。
- 请求人工核对真实业务状态。

### 11.11 Evidence 保存失败

高风险动作必须遵循：

```text
无法保存必要 Evidence
→ 不允许继续下一个高风险动作
```

低风险读取可以标记 Evidence 不完整，但必须在结果中显式显示。

## 12. 安全架构

### 12.1 信任边界

```text
可信：
Workflow Registry
Node Catalog
Policy Service
Workflow Engine
Gateway
Extension 内置代码
BPA 内置签名 Node

不可信：
网页文本
网页 DOM
网页脚本
第三方接口返回
用户导入文件
AI 生成草稿
未发布 Node
未审核 Workflow
自定义 Node 的运行时输入与输出
```

### 12.2 页面是不可信输入

页面内容可以成为业务数据，但不能：

- 修改 Workflow。
- 获取新权限。
- 指挥 Codex 或扩展执行动作。
- 触发任意代码。
- 修改审批状态。

### 12.3 最小权限

权限应绑定：

- 公司与用户。
- 设备与浏览器实例。
- 域名。
- 店铺或账号。
- Workflow。
- Node。
- 动作类型。
- 数据范围。
- 金额或数量。
- 有效时间。

不能仅按“某个 AI”授予浏览器全部权限。

### 12.4 动作风险

建议分级：

| 等级 | 示例 | 默认策略 |
|---|---|---|
| R0 | 观察、提取 | 自动执行并留痕 |
| R1 | 可重复查询、下载 | 自动执行，保存结果 |
| R2 | 可逆修改、临时选择 | 允许执行，必须验证或补偿 |
| R3 | 保存草稿、正式提交 | 明确授权或人工确认 |
| R4 | 发布、退款、改价、预算、删除 | 强制人工审批 |

### 12.5 双重策略检查

```text
Engine：Workflow 和业务范围检查
Gateway：设备、会话和审批检查
Bridge：当前页面、域名和动作检查
Adapter：目标元素和平台状态检查
```

任何一层拒绝，动作都不能执行。

### 12.6 设备身份

建议：

- 首次通过一次性配对。
- 扩展生成设备密钥。
- Gateway 保存浏览器实例公钥或设备身份。
- Session Token 短期有效。
- 支持吊销、轮换和重新配对。
- 远程连接必须使用 WSS。

正式密钥方案在 Browser Protocol v1 中确定。

### 12.7 Secret

- Secret 不进入 Workflow 文件。
- Node 只能引用 Secret Handle。
- Gateway 或 Worker 在执行时解析。
- 日志和 Evidence 中必须脱敏。
- Secret 的访问需要独立权限和审计。

### 12.8 供应链

- 正式 Node 包需要版本和摘要。
- Browser Adapter 随扩展构建发布。
- 扩展不加载远程代码。
- 发布物需要签名或可验证摘要。
- 构建、测试和发布记录关联到版本。
- 自定义 Node 即使已发布，也必须在 Node Runtime Host 中按声明权限隔离运行。
- Runtime 在加载前校验发布摘要，发现摘要、签名或权限清单不匹配时拒绝执行并告警。

## 13. 版本与升级

### 13.1 需要独立版本化的对象

- BPA Browser Protocol。
- Workflow Schema。
- Workflow。
- Node Definition Schema。
- Node。
- Adapter。
- Extension。
- Gateway。
- Workflow Engine。
- Rule Set。
- Master Data。

### 13.2 运行版本固定

每次 Run 创建后固定：

```text
workflow_version
node_versions
adapter_version
rule_versions
master_data_version
protocol_version
```

运行中不能悄悄切换正式版本。

### 13.3 兼容性

Node 和 Adapter 应声明：

- 支持的协议范围。
- 支持的 Schema 范围。
- 最低扩展版本。
- 支持的平台页面版本。
- 是否向后兼容。

Gateway 在调度前完成兼容性检查。

### 13.4 发布流程

```text
Draft
→ Validate
→ Unit Test
→ Fixture Test
→ Replay Test
→ Security Review
→ Human Approval
→ Canary
→ Published
```

### 13.5 灰度与回滚

- 新版先绑定测试设备或测试店铺。
- 小比例 Run 使用新版本。
- 比较成功率、人工接管和错误元素操作率。
- 异常时停止新任务使用新版。
- 已运行任务仍保持原版本。
- 新任务回退到上一个 Published 版本。

### 13.6 协议升级

连接时协商：

- Bridge 支持版本范围。
- Gateway 支持版本范围。
- 最终选定版本。
- 不兼容时明确拒绝，不尝试猜测字段。

## 14. 数据与存储

### 14.1 数据分类

- 控制数据：Workflow、Node、Adapter、Policy。
- 运行数据：Run、Node Execution、Human Task。
- 事件数据：追加式 Execution Event。
- 证据数据：DOM 摘要、截图、文件和验证结果。
- 业务数据：提取结果、主数据和规则。
- 审计数据：发布、审批、权限和操作记录。

### 14.2 持久化原则

BPA Core 不依赖 PostgreSQL、SQLite 或某个 ORM，而是依赖面向领域的 Persistence Ports。

不建议建立一个过度通用的 CRUD Repository。BPA 真正需要的是明确的业务持久化语义：

- 不可变版本读取和发布。
- Run 与 Node Execution 的原子状态转换。
- 追加式事件。
- Idempotency Key 唯一性。
- Browser Command 与 Result 恢复。
- Lease / Compare-and-Set。
- Human Task。
- Evidence 元数据和对象引用。
- 审计记录。

建议拆分为：

```text
RegistryStore
ExecutionStore
EventStore
IdempotencyStore
GatewayStateStore
HumanTaskStore
AuditStore
EvidenceMetadataStore
BlobStore
ExecutionUnitOfWork
GatewayDeliveryUnitOfWork
```

每个 Port 定义自己需要的一致性和查询能力；`ExecutionUnitOfWork` 负责 Engine 执行账本的强原子提交，`GatewayDeliveryUnitOfWork` 负责单个 Gateway 投递账本的强原子提交。跨进程、跨设备使用 Transactional Outbox / Inbox 和幂等消费，不使用分布式数据库事务。

### 14.3 Registry 唯一事实来源

运行时唯一正式事实来源是 `RegistryStore` 中的 Published Artifact。它保存不可变的 Workflow、Node、Adapter、Policy 版本及其内容摘要。

Git 的角色限定为：

- 人可审阅的候选定义与变更历史。
- Published Artifact 的只读导出和灾备快照。
- 通过 Pull Request 参与评审，不直接被 Worker 当作运行时 Registry。

从 Git 或文件系统导入的内容必须经过统一发布管线：

```text
Candidate
→ Validate
→ Test
→ Review / Approval
→ Compile
→ 生成内容摘要
→ 原子写入 RegistryStore
→ Published
→ 可选 Git 只读导出
```

同一资产版本一经 Published 不可原地修改；相同 `asset_id + version` 的内容摘要必须唯一。禁止 Registry 与 Git 双向自动同步或 Last-Write-Wins。恢复时以 Registry 中已发布摘要为准，导入快照也必须重新校验后发布。

### 14.4 引导式持久化封装

面向使用者提供三种引导模式：

```text
local
  → SQLite WAL + Local Files

team
  → PostgreSQL + S3-compatible Blob Store

custom
  → 用户实现 Persistence Ports
```

配置入口可以表现为：

```text
createBpaPersistence({
  mode: "local" | "team" | "custom"
})
```

这只是引导式工厂，不应把底层数据库能力泄露给 Workflow Engine。

启动时需要运行 Persistence Conformance Check：

- 是否支持 `ExecutionUnitOfWork` / `GatewayDeliveryUnitOfWork` 要求的原子事务与崩溃恢复。
- 是否支持唯一约束或等效原子语义。
- 是否支持追加事件。
- 是否支持 Lease 或 Compare-and-Set。
- 是否能够恢复未完成 Command。
- Blob Store 是否可写、可读和校验摘要。
- Schema Migration 是否兼容当前 BPA 版本。

### 14.5 官方适配器

| 适配器 | 用途 |
|---|---|
| `memory` | 单元测试、模拟和短生命周期工具 |
| `sqlite` | 本地默认、单机 Engine、Local Gateway |
| `postgres` | 多用户、集中控制平面、多 Worker 和高可用 |
| `local-fs` | 本地 Evidence 与文件 |
| `s3` | 集中式大型 Evidence |
| `indexeddb` | Extension Pending Result 和本地 Bridge 状态 |

PostgreSQL 是官方生产适配器，但不是运行 BPA 的前置条件。

当出现以下需求时再选择 PostgreSQL：

- 多个 Workflow Worker 并发。
- 多用户共享 Registry。
- 集中权限和审计。
- 高可用部署。
- 跨设备任务管理。
- 复杂查询和运营报表。

### 14.6 数据落点建议

| 数据 | 本地模式 | 集中模式 |
|---|---|---|
| Published Workflow / Node / Policy | SQLite Registry + Git 只读导出 | PostgreSQL Registry + Git 只读导出 |
| Candidate 资产 | Git / 工作区 | Git / Studio 草稿库 |
| Run / Node Execution | SQLite WAL | PostgreSQL |
| Execution Event | SQLite 追加表 | PostgreSQL 追加表 |
| Gateway 恢复状态 | SQLite WAL | SQLite 或 PostgreSQL |
| Bridge Pending Result | IndexedDB / chrome.storage | IndexedDB / chrome.storage |
| 大型 Evidence | Local Files | S3 兼容对象存储 |
| Evidence 索引 | SQLite | PostgreSQL |

### 14.7 强制事务边界

一次 Engine 侧 Node 状态推进必须通过 `ExecutionUnitOfWork` 在同一个原子提交中写入：

- Node Execution 状态转换。
- 对应 Execution Event。
- Idempotency 记录。
- Engine Inbox 中已接收 Result 的消费状态。
- 需要发送给 Gateway 的 Command Outbox 记录。

建议暴露领域操作而不是让 Engine 自行拼接多个 Port 调用：

```text
commitNodeTransition(
  expected_revision,
  next_node_execution,
  execution_event,
  idempotency_mutation?,
  command_outbox_or_result_inbox_mutation?
)
```

提交必须带 `expected_revision` 或等效 Compare-and-Set；冲突只能返回确定的并发错误，不能覆盖新状态。任何部分失败都必须整体回滚，重启后不得出现“状态已成功但事件丢失”或“Result 已消费但幂等记录丢失”。

Gateway 侧通过 `GatewayDeliveryUnitOfWork` 原子更新 Command、ACK、Result Inbox/Outbox 和投递幂等记录。Central Engine、Local Gateway、Bridge 之间不追求跨数据库原子事务，而是采用：

```text
本地事务写状态 + Outbox
→ 至少一次传输
→ 对端 Inbox 去重
→ 本地事务消费 Inbox 并推进状态
→ ACK 后清理 Outbox 正文
```

因此网络分区最多造成重复投递或迟到结果，不能造成重复业务状态推进。

Evidence 大对象可以独立存储，但必须先获得内容摘要和稳定引用，再提交高风险动作的完成状态。

自定义适配器只有通过包含进程崩溃、事务中断、重复提交与并发竞争的 Conformance Suite，才可以用于持久化运行。

### 14.8 Migration

- BPA Core 定义逻辑 Schema 版本。
- 每个官方 Persistence Adapter 维护自己的数据库 Migration。
- 启动前检查版本，不允许静默降级。
- Migration 必须声明兼容窗口、升级前检查和回滚/恢复方案。
- 破坏性 Migration 采用 Expand → Migrate → Contract；新旧应用版本在声明窗口内可共存。
- Migration 失败时不得半初始化启动；保持旧版本可运行或明确停止并从备份恢复。
- 自定义适配器必须通过当前版本 Conformance Suite。

### 14.9 保留与删除

- 不同 Evidence 类型设置保留期。
- 高风险审计按公司规则长期保留。
- 页面文本和截图按最小必要原则保存。
- 支持按公司、店铺、Run 定位和清理。
- 删除行为本身需要审计。

## 15. 部署形态

### 15.1 本地一体化

```text
Codex / UI
→ Local BPA Process
   ├─ Control API
   ├─ Engine
   ├─ Gateway
   └─ SQLite
→ Chrome Extension
```

适合：

- 原型。
- 单用户。
- 内部验证。
- 离线或敏感场景。

### 15.2 混合部署

```text
公司中心端
├─ Registry / Policy / Audit
├─ Workflow Engine
├─ NodeExecution Ledger        # 业务执行权威账本
└─ Command Broker
        ▲
        │ 由 Local Gateway 主动发起的出站 WSS
        │（认证、断线续传、序列号、Fencing Token）
        ▼
用户电脑
├─ Local Gateway
│  └─ Delivery Ledger          # 浏览器投递权威账本
└─ Chrome Extension
   └─ Result Outbox
```

混合部署采用“单一业务所有者 + 分层投递账本”：

- Central Engine 是 Workflow Run、Node Execution 和业务状态推进的唯一所有者。
- Local Gateway 是该设备上 Command 投递、ACK、Result 接收和标签页 Lease 的唯一所有者。
- Bridge 只拥有本地动作执行与 Result Outbox，不拥有 Workflow 状态。
- Local Gateway 主动建立出站 WSS，中心端不要求穿透用户电脑 NAT，也不直接连接扩展。
- `node_execution_id` 全局唯一；每次投递另有唯一 `command_id`，重投不创建新的 Node Execution。
- 中心端在创建 Command 时将 Engine 状态与 Command Outbox 原子提交；Local Gateway 通过 Inbox 幂等接收。
- Local Gateway 将 Result 与 Result Outbox 原子提交；中心端通过 Inbox 幂等消费并推进 Node。
- Command、Result 和所有权移交都携带单调递增的 `fencing_token`。
- 中心端只有在原 Lease 失效并完成业务状态验证后，才能把执行权移交给另一个 Gateway。
- 设备离线时中心端保留待投递 Command；Local Gateway 只重放已持久化且未确认的投递，不自行创建后续业务节点。

不得同时由本地 Engine 和 Central Engine 推进同一个 Run。离线自治若未来需要支持，必须采用独立 Run 分片和显式所有权转移协议，不在 v1 隐式实现。

适合：

- 多用户。
- 公司集中治理。
- 使用员工真实登录态。
- 设备可以短暂离线。

### 15.3 企业集中部署

```text
Central Control Plane
→ Remote Gateway Service
→ Device Agent / Native Host
→ Extension Bridge
```

适合：

- 大规模设备管理。
- 集中身份和策略。
- 企业安装器。
- 多地区部署。

第一阶段推荐本地一体化，架构接口按照混合部署设计。

## 16. 技术选型

### 16.1 总体原则

- 优先 TypeScript 统一前后端、扩展、Schema 和 MCP 工具链。
- 协议和正式资产采用开放、语言无关格式。
- 第一阶段减少基础设施数量。
- 为后续分布式运行保留清晰接口。

### 16.2 推荐栈

| 层 | 选择 |
|---|---|
| 语言 | TypeScript |
| Node Runtime | Node.js LTS，最低 22 |
| Monorepo | pnpm workspace |
| 构建 | TypeScript + Vite |
| Web API | Fastify |
| Canonical Schema | JSON Schema 2020-12 |
| Schema Validation | Ajv |
| 内部 TS 输入校验 | Zod，仅限非正式协议或 UI |
| 持久化抽象 | Domain-specific Persistence Ports |
| 本地默认适配器 | SQLite WAL + Local Files |
| 集中部署适配器 | PostgreSQL + S3-compatible Blob Store |
| Adapter 数据访问 | Drizzle，可替换且不暴露给 Core |
| 扩展框架 | WXT |
| 扩展 UI | React |
| 浏览器通信 | WebSocket，后续 Native Messaging |
| Workflow Engine v1 | 自研小型事件驱动状态机 |
| 分布式演进候选 | Temporal |
| 对象存储 | S3 兼容存储 |
| 可观测性 | OpenTelemetry |
| 单元测试 | Vitest |
| 浏览器测试 | Playwright |
| 集成环境 | Testcontainers |
| Codex 接入 | Repo Skill + MCP Server |

### 16.3 Schema 选择

正式对外对象使用 JSON Schema 2020-12：

- Workflow。
- Node Definition。
- Browser Protocol。
- Permission。
- Execution Event。
- Evidence Metadata。

理由：

- 与语言无关。
- 可以生成编辑器提示。
- 可以用于运行时校验。
- 便于版本和兼容性管理。

Zod 可继续用于扩展内部 UI 和非正式消息，但不能成为正式协议的唯一事实来源。

### 16.4 Workflow Engine

v1 不直接使用 Temporal。

原因：

- 当前最需要验证的是 Workflow DSL、节点边界和浏览器执行。
- 先降低部署和调试复杂度。
- 现有场景的规模可以由 PostgreSQL/SQLite 状态机支持。

迁移条件：

- 大量长时间 Workflow。
- 多 Worker 和跨区域调度。
- 复杂定时器和外部 Signal。
- 自研恢复成本明显增加。

Temporal 以后可以作为执行底座，但 BPA Workflow DSL 仍然是上层正式资产。

### 16.5 Gateway

第一阶段：

- TypeScript。
- `ws` WebSocket Server。
- SQLite WAL 持久化。
- 本地 Loopback 监听。
- 一次性配对和设备身份。

后续：

- Native Messaging Transport。
- WSS Remote Gateway。
- OIDC 和企业设备证书。

### 16.6 浏览器扩展

- WXT + Manifest V3。
- Service Worker 承担 Bridge。
- Content Script 承担页面 Adapter。
- Side Panel 展示任务、权限、证据和人工操作。
- IndexedDB 保存 Pending Result 与本地状态。
- 不加载远程代码。

### 16.7 可观测性

统一 Trace：

```text
Trigger
→ Workflow Run
→ Node Execution
→ Gateway Command
→ Bridge Execution
→ Adapter Action
→ Evidence
```

每层携带：

- `trace_id`
- `run_id`
- `node_execution_id`
- `browser_instance_id`
- `adapter_version`

默认遥测采用字段 Allowlist，只允许：

- 不可逆或无业务含义的 ID。
- 状态、耗时、重试次数、容量与协议版本。
- 结构化错误码和经过分级的组件版本。

默认禁止进入 Trace、Metric 和普通 Log：

- DOM、HTML、截图正文和页面字段值。
- Cookie、Token、Secret、请求头和审批凭证。
- 店铺名、商品名、用户输入等可识别业务内容。
- Node 原始输入输出和 Evidence 正文。

需要业务字段进行诊断时，必须按字段显式启用、执行脱敏并设置短期保留。Evidence 使用独立存储、ACL、审计和保留策略；日志只保存 Evidence 引用与摘要，不能把 Evidence 当日志附件复制。

遥测导出失败不得阻塞正常的低风险执行，但本地缓冲同样遵守容量、TTL 和敏感字段策略。高风险审计失败按第 11 节兜底规则停止推进。

## 17. 推荐目录结构

```text
bpa/
├── apps/
│   ├── control-api/                 # Registry、Policy、发布 API
│   ├── studio/                      # Workflow/Node 管理界面
│   ├── workflow-worker/             # Workflow Engine Worker
│   ├── node-runtime-worker/          # 隔离执行自定义 Engine Node
│   ├── gateway/                     # Browser Gateway
│   ├── extension/                   # Chrome Extension
│   ├── mcp-server/                  # Codex 工具
│   └── cli/                         # validate、compile、test、replay
│
├── packages/
│   ├── workflow-schema/             # Workflow JSON Schema
│   ├── node-schema/                 # Node Definition JSON Schema
│   ├── protocol-schema/             # Browser Protocol Schema
│   ├── permission-schema/           # 权限和审批 Schema
│   ├── evidence-schema/             # Evidence Metadata
│   ├── event-schema/                # Execution Event
│   ├── workflow-compiler/           # DSL → IR
│   ├── workflow-engine/             # 状态机和调度接口
│   ├── node-runtime/                 # Node Runtime Host、配额和 Capability API
│   ├── node-runtime-protocol/        # Engine 与隔离 Worker 通信协议
│   ├── node-sdk/                    # Node 开发 SDK
│   ├── adapter-sdk/                 # Browser Adapter SDK
│   ├── browser-kernel/              # 通用浏览器动作
│   ├── gateway-core/                # 会话、ACK、去重和路由
│   ├── policy/                      # 权限和风险计算
│   ├── persistence/                 # 领域 Persistence Ports
│   ├── persistence-memory/          # 测试适配器
│   ├── persistence-sqlite/          # 本地默认适配器
│   ├── persistence-postgres/        # 集中部署适配器
│   ├── blob-store-local/            # 本地 Evidence
│   ├── blob-store-s3/               # 集中 Evidence
│   ├── evidence/                    # Evidence 领域接口
│   ├── observability/               # Trace、Metric、Log
│   └── shared/                      # 通用类型和工具
│
├── nodes/
│   ├── core/
│   │   ├── control/
│   │   ├── browser/
│   │   ├── data/
│   │   ├── human/
│   │   └── system/
│   └── custom/
│       ├── doudian/
│       ├── chanmama/
│       └── qianchuan/
│
├── adapters/
│   ├── doudian/
│   ├── chanmama/
│   └── qianchuan/
│
├── workflows/
│   ├── examples/
│   ├── tests/
│   └── published-export/
│
├── skills/
│   ├── bpa-workflow-authoring/
│   └── bpa-node-authoring/
│
├── tests/
│   ├── contract/
│   ├── fixtures/
│   ├── replay/
│   ├── integration/
│   ├── browser/
│   ├── security/
│   └── performance/
│
├── experiments/
│   └── bridge-gateway/
│
├── docs/
│   ├── architecture/
│   ├── protocols/
│   ├── adr/
│   ├── operations/
│   └── security/
│
├── pnpm-workspace.yaml
├── package.json
├── AGENTS.md
└── README.md
```

## 18. 模块边界

### Control API

可以：

- 管理草稿。
- 执行校验。
- 提交审核。
- 发布版本。

不可以：

- 直接下发浏览器动作。
- 绕过 Engine 创建 Gateway Command。

### Workflow Engine

可以：

- 调度已发布 Node。
- 创建 Human Task。
- 请求 Gateway 执行浏览器节点。

不可以：

- 读取 DOM。
- 生成任意浏览器代码。
- 修改已发布 Workflow。

### Node Runtime Host

可以：

- 按固定摘要加载 Published Node。
- 在隔离进程中执行自定义 Engine Node。
- 代理经声明和授权的 Capability API。
- 实施资源配额、超时、终止和输出校验。

不可以：

- 让 Node 直接访问宿主 Secret、文件系统、网络或环境变量。
- 执行未发布、摘要不匹配或权限未批准的 Node 包。
- 自行推进 Workflow 状态或绕过 `ExecutionUnitOfWork`。

### Gateway

可以：

- 管理会话。
- 校验能力。
- 下发节点。
- 接收结果。

不可以：

- 决定 Workflow 分支。
- 修改业务参数。
- 批准高风险动作。

### Bridge

可以：

- 校验当前页面。
- 调用内置动作和 Adapter。
- 拒绝越权命令。

不可以：

- 接受任意代码。
- 自行选择业务 Workflow。
- 跳过本地策略。

### Adapter

可以：

- 识别平台页面和控件。
- 执行声明过的平台能力。

不可以：

- 获得未声明域名权限。
- 隐藏跨业务的完整 Workflow。

## 19. 测试体系

### 19.1 Schema 测试

- 合法和非法 Workflow。
- Node 输入输出兼容性。
- 协议版本兼容。
- Permission 边界。

### 19.2 Node 契约测试

- 输入校验。
- 输出校验。
- 错误码。
- 超时。
- 幂等。
- Evidence。

### 19.3 页面夹具测试

- 正常页面。
- 慢加载。
- 空列表。
- 虚拟列表。
- 多分页。
- 动态字段。
- 弹窗。
- DOM 轻微改版。
- 验证码。
- 无唯一目标。

### 19.4 Replay 测试

使用历史事件、DOM 摘要和人工修正验证：

- 新 Workflow。
- 新 Node。
- 新 Adapter。
- 新规则版本。

### 19.5 故障注入

- Bridge 断线。
- Gateway 重启。
- Engine 重启。
- Node Runtime 崩溃、超时和资源耗尽。
- ACK 丢失。
- Result 重复。
- 原子提交中途崩溃。
- 并发 Worker 使用过期 Revision 提交。
- Lease 过期后旧持有者返回迟到 Result。
- Cancel 与业务提交同时发生。
- Evidence 上传失败。
- 标签页被用户关闭。
- 补偿失败。

### 19.6 安全测试

- 页面提示注入。
- 任意代码请求。
- 域名越权。
- 店铺串用。
- 审批 Token 重放。
- Loopback Origin 伪造、端口扫描和消息重放。
- Secret 泄露。
- 自定义 Node 越权访问文件、网络、环境变量和其他租户数据。
- 遥测和本地 Outbox 敏感数据泄露。
- 节点版本降级。
- 恶意导入文件。

### 19.7 Persistence Adapter Conformance

所有官方和自定义持久化适配器使用同一套黑盒测试：

- 在事务的每个写入点注入进程崩溃，恢复后只能看到完整旧状态或完整新状态。
- 并发提交相同 `expected_revision` 时只能有一个成功。
- 重复消费相同 Inbox 消息不重复推进状态。
- Outbox 在发送后、ACK 前崩溃可以重发且不重复产生业务副作用。
- 旧 `fencing_token` 不能写入当前状态，但迟到结果会形成审计记录。
- Migration 中断后不得进入半升级可运行状态。
- SQLite 与 PostgreSQL 官方适配器对同一状态机夹具产生等价领域结果。

## 20. 运营与治理

### 20.1 角色

- Workflow Owner：业务结果负责。
- Node Owner：节点正确性负责。
- Adapter Owner：平台兼容性负责。
- Security Reviewer：权限和高风险动作负责。
- Operator：运行和人工接管。
- Release Manager：版本发布和回滚。

### 20.2 审批

区分：

- 资产发布审批。
- 运行时高风险动作审批。
- 设备配对审批。
- 权限扩大审批。

Codex 可以准备材料，不能代替责任人批准。

### 20.3 指标

- Workflow 成功率。
- Node 成功率。
- 错误元素操作率。
- 人工接管率。
- 自动恢复率。
- `uncertain` 比例。
- Evidence 完整率。
- Adapter 异常率。
- 第二场景节点复用率。
- 从需求到可测试 Workflow 的时间。

## 21. 演进路线

### 阶段 A：标准化现有场景

- 固定重点项插件行为基准。
- 定义 Workflow、Node、Event、Permission Schema。
- 将现有流程表达为第一个 Workflow。
- 继续复用经过验证的抖店代码。

### 阶段 B：平台内核

- Workflow Compiler。
- 小型持久化 Engine。
- Node Catalog。
- Browser Gateway。
- Extension Bridge。
- Evidence 和 Audit。

### 阶段 C：Codex 创作工具

- Workflow Authoring Skill。
- Node Authoring Skill。
- BPA MCP Server。
- `workflow_gen`。
- `node_gen`。

### 阶段 D：第二场景验证

选择相邻场景，验证：

- 通用节点复用率。
- 新 Adapter 工作量。
- Workflow 定制时间。
- 安全边界是否保持。

### 阶段 E：集中治理

- PostgreSQL。
- 公司身份。
- 设备管理。
- 远程 Gateway。
- 灰度发布。
- 集中审计。

## 22. v1 必须具备

### 必须

- Workflow 和 Node 独立版本。
- JSON Schema 校验。
- 权限和风险声明。
- Engine 持久化。
- Gateway ACK 和去重。
- Bridge Pending Result。
- `uncertain`。
- Page Epoch。
- 人工审批和接管。
- Evidence。
- Adapter 版本。
- 发布和回滚。
- Persistence Ports 与本地 SQLite 官方适配器。
- `ExecutionUnitOfWork` 原子提交和适配器 Conformance Suite。
- Node Runtime Host 与自定义 Node 隔离。
- 带 Fencing Token 的 Lease 和明确 Cancel 语义。
- Loopback 配对、握手、防重放、轮换和吊销。
- AI 不可用时可人工运行。

### 可以延后

- Temporal。
- Native Messaging。
- 远程 Gateway。
- 多地区部署。
- 可视化拖拽编辑器。
- 自动生成 Browser Adapter 代码。
- 大规模并行。
- 完整商业化多租户计费。

## 23. 核心架构决策

1. Workflow 是公司资产，不是提示词。
2. Node 是受治理能力，不是任意代码。
3. Adapter 处理平台差异，不承载完整 Workflow。
4. Engine 决定流程，Gateway 负责投递，Bridge 负责本地安全执行。
5. 页面是数据，不是指令。
6. Command ACK 与 Result ACK 分离。
7. `uncertain` 是一等状态。
8. 已发布版本不可原地修改。
9. 运行中固定所有关键版本。
10. 高风险动作需要独立审批凭证。
11. AI 不可用不能导致已发布 Workflow 失效。
12. 第一阶段保持基础设施简单，但接口面向混合部署。
13. BPA Core 依赖持久化能力契约，不依赖 PostgreSQL 或具体 ORM。
14. RegistryStore 中的 Published Artifact 是运行时唯一事实来源，Git 不是并行运行时数据库。
15. Node 状态、事件、幂等和关联投递状态必须原子提交。
16. 自定义 Engine Node 必须通过 Node Runtime Host 隔离执行。
17. 混合部署中 Central Engine 拥有业务账本，Local Gateway 拥有设备投递账本。
18. Lease 使用单调 Fencing Token；Cancel 是停止意图，不代表副作用已回滚。
19. 可观测性默认只记录 Allowlist 元数据，Evidence 与普通日志分离。

## 24. 参考资料

- [JSON Schema Specification](https://json-schema.org/specification)
- [Chrome Extension Message Passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome Extension Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome WebSockets in Extension Service Workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Temporal Documentation](https://docs.temporal.io/)
- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Codex Skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
