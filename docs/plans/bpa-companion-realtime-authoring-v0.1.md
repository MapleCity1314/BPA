# BPA Companion：Codex + MCP + Hook 实时协作 v0.1

> **部分作废标注（2026-08-06）**
>
> 本文件的产品决定部分已被 `docs/normative/bpa-product-form-v1.md` 取代。
> 冲突处一律以形态定义为准。具体：
>
> | 本文件条目 | 判定 |
> | --- | --- |
> | §1 / §状态"取消低负担业务工作台、不保留兼容入口" | **作废**。`apps/operator-console` 是客户主界面，占用户 ~90% 时间 |
> | §4 Side Panel 承担主要交互 | **降级**。Extension 面板仅承担创作（取元素、确认选择器），约 10% |
> | §7 "最终方向是独立 Rust Core Daemon" | **作废**。除非 Node 侧瘦身彻底失败，否则不启动；见路线冻结清单 |
> | Codex 会话镜像作为产品能力 | **作废**。内部开发者工具，不进产品线 |
> | 隐含的 Windows 桌面优先前提 | **作废**。形态是服务器，Windows 签名/SmartScreen/MSIX 从 P0 降为 P2 |
>
> **仍然有效并继续作为依据的部分**：§3 `bpa.conversation-event/1` 事件封装与
> 安全字段策略（内部工具仍可能使用）；§5 工程边界与通用副作用节点约束
> （HTTP Request / File Write / JSON Transform，见路线阶段 3）；
> §6 签名交付闭包的排除清单；§9 中与上述保留部分对应的验收项。

## 状态

- 权威等级：迭代计划
- 实现状态：计划中
- 替代方案：取消“低负担业务工作台”，不保留兼容入口
- 产品载体：Chrome Side Panel + 本地 Conversation Bridge
- 不改变的边界：候选不能直接发布；页面内容是不可信数据；阻断风险必须停止；
  不确定写入不能自动重试

## 1. 产品决定

BPA 不再开发一套独立的低负担运营工作台。Extension 前端改造成
`BPA Companion`：它跟随当前明确选择的 Codex 会话，接收会话事件、页面上下文、
需求记录、能力缺口、候选产物和运行进度，让 AI 协作直接发生在浏览器侧栏。

这不是抓取 ChatGPT/Codex 网页 DOM 的插件，也不读取 Cookie、隐藏推理或浏览器
会话凭证。BPA 只接收 Codex App Server 明确发布的事件，以及用户授权采集的页面
证据。

## 2. 三条通道的职责

```text
Codex App Server ──实时 Thread/Turn/Item 事件──▶ Conversation Bridge
                                                    │
                                                    ▼
Codex MCP Server ◀──语义工具/资源── BPA Core ◀── Native Messaging ──▶ Side Panel
                                                    ▲
Codex Hooks ───────生命周期检查点与审计───────────────┘
```

### Codex App Server：实时主通道

App Server 提供 Thread、Turn、Item 历史和增量事件。Conversation Bridge 使用
stdio 或 Unix socket 连接 App Server，完成事件排序、去重、游标续传、脱敏和
背压，再通过 Native Messaging 交付 Side Panel。

App Server 是唯一的会话实时来源。实验性的 WebSocket 传输不进入生产依赖。

### MCP：语义与动作通道

MCP 不复制聊天流，只暴露 BPA 的受控能力：

- `page.capture`：读取当前已授权页面的结构化证据。
- `requirement.upsert`：登记可追踪的工作流数据需求。
- `capability_gap.list`：列出缺失的节点、适配器和权限。
- `candidate.build`：生成不可执行的 Workflow/Node 候选。
- `workflow.run`：只运行已发布版本，并继续受权限、租约和风险策略约束。
- `run.inspect`：读取运行进度、证据与失败语义。

工具输出使用明确 Schema；敏感字段不进入模型上下文；任何外部 MCP 服务都必须
单独信任和授权。

### Hooks：生命周期检查点

Hooks 只记录 `SessionStart`、`UserPromptSubmit`、关键 `PostToolUse`、`Stop` 和
`SessionEnd` 检查点，用于审计、刷新索引和兜底通知。Hook 命令必须短小、可失败、
不持有生产租约，也不能成为实时消息主通道。当前 command hooks 可用，但异步 hooks
不作为可用能力设计。

## 3. Conversation Bridge

第一版只定义一个稳定事件封装：

```json
{
  "schema": "bpa.conversation-event/1",
  "eventId": "evt_...",
  "threadId": "thr_...",
  "turnId": "turn_...",
  "sequence": 42,
  "occurredAt": "2026-08-06T00:00:00.000Z",
  "kind": "item.updated",
  "visibility": "user_visible",
  "payload": {}
}
```

Bridge 必须具备：

1. 用户显式选择同步的 Thread；默认不订阅全部历史会话。
2. 本地设备身份、短期连接授权和 Extension allowlist。
3. 游标持久化、断线续传、同一事件幂等处理和有界队列。
4. 只传递用户可见内容；工具原始输出先经过字段级脱敏。
5. 审计记录只保存摘要、标识和结果，不复制完整敏感会话。

## 4. Side Panel 信息架构

Popup 只保留连接状态和“打开 BPA Companion”。主要交互迁移到 Side Panel：

- 会话：当前 Thread、连接状态、最近用户可见消息。
- 页面上下文：当前 Tab、来源、Page Epoch、授权状态和已采集证据。
- 需求：AI 从会话提取但仍待用户确认的数据要求。
- 构建：Workflow、Node、Adapter 候选和 Capability Gap。
- 运行：已发布工作流的阶段、结果、人工动作和证据。

Side Panel 不承担 Core 状态推断。它只渲染协议事件，并把用户动作发送给 Core。

## 5. 工程边界

```text
Workflow  = 编排、数据依赖、失败策略和恢复点
Node      = 单一可测试能力，纯计算节点与有副作用节点明确区分
Adapter   = 外部平台语义、认证、页面/API 差异与原始数据归一化
Core      = 协议、权限、租约、执行、证据、审计和发布边界
```

通用副作用节点先实现最小集合：受策略约束的 HTTP Request、原子 File Write、
结构化 JSON Transform。HTTP POST 不是 Adapter 的替代品：平台特有认证、签名、
限流、分页和错误语义仍属于 Adapter。File Write 必须限制根目录、采用临时文件后
原子替换，并且对不确定结果不自动重试。

## 6. 交付与保护

公司设备不再部署完整源码仓库。目标交付闭包为：

- 签名的 BPA Core、Native Host/Bridge 和 Node Runtime；
- 构建后的 Extension；
- 已发布 Workflow、Node manifest、Schema 和必要运行资产；
- 设备绑定身份、最小权限服务账户、版本清单和可验证签名；
- 不包含测试、源码、source map、开发文档、签名私钥和长期通用凭证。

JavaScript 混淆或运行时解密只能提高提取成本，不能阻止拥有机器管理员权限的人。
真正的核心算法如果不能暴露，应移到自有受控服务；必须本地运行的敏感能力可收敛
到签名的 Rust Native Runtime，但仍要按“可被逆向”设计密钥与权限。

## 7. Rust Runtime 方向

Rust 优先用于确定性 Runtime、安全和进程隔离边界，而不是替换浏览器自动化。
最终方向是独立 Rust Core Daemon，加上 TypeScript Extension、Node、Adapter 和受限
Worker。详细职责、并发、持久化、性能 SLO、迁移和交付规范见
`docs/plans/bpa-rust-core-runtime-architecture-performance-v0.1.md`。

页面等待、登录和网络延迟不会因为改写 Rust 自动变快；Chrome、Extension 与屏幕
共享必须作为独立性能域治理。计算数据面继续采用整批 TypedArray 跨越 Node-API
边界，禁止逐 SKU 调用。

截至 2026-08-06，第一层 `@bpa/inventory-kernel` 已实现：777 个 SKU、每个 2161
小时序列的本机基准从 TypeScript 约 1400.32ms 降至 Rust 批量调用约 265.53ms，
约 5.27 倍加速。Rustfmt、Clippy、release 构建和黄金一致性测试已进入 `pnpm verify`；
在预编译产物进入签名 Runtime Closure 前，不切换生产调用。

## 8. 分层落地

1. 固化 `bpa.conversation-event/1` 与安全字段策略。
2. Bridge 接通 App Server，完成断线续传和只读会话同步。
3. Popup 收缩、Side Panel 上线，展示会话与页面证据。
4. MCP 接入 requirement、gap、candidate 和 run inspect。
5. Hooks 接入生命周期审计，不阻塞 Codex 主流程。
6. 增加 HTTP Request、File Write、JSON Transform 节点并完成契约测试。
7. 建立签名发布闭包和公司设备安装包。
8. 以库存工作流作为首个端到端业务验收。

每一层都必须在上一层可独立工作后再扩展。

## 9. 验收标准

- 用户选择一个 Thread 后，Side Panel 能持续显示有序、去重的用户可见事件。
- Bridge 重启后从游标恢复，不重复创建需求或候选。
- Extension 不读取 ChatGPT/Codex DOM、Cookie、隐藏推理或未选择会话。
- MCP 工具受现有权限、租约、审计和发布状态约束。
- Hook 故障不会阻断会话或留下生产租约。
- 候选 Workflow/Node 仍需审核和发布后才能执行。
- 公司安装包不含源码、source map、私钥或开发凭证，并可验证完整性。
- 库存工作流能从会话要求进入需求、构建、发布、运行和证据闭环。

## 10. 官方依据

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [MCP and connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
