# BPA 基础场景、工程闭环与 AI 创作设计 v0.4

状态：候选设计

日期：2026-07-28

适用范围：BPA `0.3.x` 之后的执行与创作能力规划

本文不修改已经确认的 `bpa.browser/1`。PageModel、ElementContract、HumanTask
和结构化循环仍是候选模型；进入正式 JSON Schema 和协议前需要人工确认。

## 1. 设计结论

BPA 不应只被理解为“按顺序点击页面”。它需要稳定覆盖以下五类工作：

1. 一次性的单节点工具调用。
2. 可恢复的长流程，其中穿插人工处理、定时等待和外部事件。
3. 对集合、分页和未知完成时间任务的有界循环。
4. 浏览器、API、文件和人工步骤组成的混合流程。
5. AI 辅助创作，但最终只运行已发布的语义 Node 和固定版本 Workflow。

因此，后续执行模型应收敛到少量可组合原语，而不是允许任意有向图：

```text
Step
├── Task             执行一个 Node
├── Decision         condition / switch
├── Wait             timer / event / human
├── Iterate          foreach / paginate / poll / bounded repeat
├── Group            sequence / bounded parallel
├── Call             subworkflow
└── Terminal         succeed / fail / cancel / uncertain
```

任意回边仍然禁止。循环必须编译为带上限、作用域、检查点和迭代身份的
`Iterate`，这样才能保证恢复、审计和幂等语义。

## 2. 基础需求情况

### 2.1 触发和运行方式

| 需求 | 示例 | 所需能力 |
| --- | --- | --- |
| 手工运行 Workflow | 用户在 CLI 中发起重点项检查 | 已发布 Workflow、输入校验、审计 |
| 单独运行一个 Node | 临时读取当前店铺名称 | `SingleNodeRun` 包装器、权限预览 |
| AI 发起候选流程 | Codex 根据业务目标组合 Node | Candidate、模拟、人工发布 |
| 定时触发 | 每天首次打开店铺后检查 | Schedule Trigger、去重窗口 |
| 外部事件触发 | 文件到达、Webhook、审批回调 | Event Trigger、相关键、Inbox |
| 页面上下文触发 | 用户进入受支持页面后提示检查 | 显式订阅、节流、只提示不自动写 |
| 批量运行 | 对多个商品逐个检查 | Batch Run、并发上限、部分结果 |
| 影子运行 | 新旧 Adapter 同时只读比较 | Shadow Run、差异报告、无写权限 |

`SingleNodeRun` 不应成为绕过 Workflow 安全边界的后门。Core 应生成一个
只包含 start、目标 Node 和明确终点的临时执行计划，并照常固化版本、权限、
输入、事件、证据和审计。

### 2.2 控制流

| 模式 | 应使用的原语 | 关键约束 |
| --- | --- | --- |
| 真假判断 | `condition` | 条件 DSL，不执行代码 |
| 多分支 | `switch` | 分支互斥或声明优先级，必须有 default |
| 固定集合遍历 | `foreach` | `max_items`、逐项检查点、稳定 item key |
| 页面分页 | `paginate` | 稳定 cursor、最大页数、重复 cursor 检测 |
| 等待状态改变 | `poll` | 总时限、退避、抖动、平台限流信号 |
| 有界重复 | `repeat` | 最大次数和退出条件，不允许无限循环 |
| 多任务并发 | `parallel` + `join` | 并发上限、聚合策略、取消传播 |
| 调用可复用流程 | `subworkflow` | 精确版本、输入输出映射、深度上限 |
| 失败后恢复 | `retry` | 只处理瞬时失败，不代替业务循环 |
| 撤销已确认副作用 | `compensate` | 显式补偿栈，不能假定所有写操作可逆 |

下列概念必须保持区分：

- `retry`：同一执行尝试因瞬时错误重做。
- `poll`：重新读取外部状态，直到条件满足。
- `foreach`：对一组有稳定身份的数据逐项处理。
- `paginate`：通过外部 cursor 获取下一批数据。
- `repeat`：有限次重复一段流程。
- `wait`：当前步骤不执行，等待持久化唤醒条件。

### 2.3 人工参与

人工步骤不应只有“批准/拒绝”。至少需要以下类型：

| 类型 | 适用场景 | 结果 |
| --- | --- | --- |
| `approval` | 高风险动作前确认 | approve / reject |
| `input` | 补录验证码、原因、业务字段 | 经过 Schema 校验的表单值 |
| `action` | 要求人在页面完成登录、拖拽或复杂操作 | completed / unable |
| `review` | 对扫描结果、差异或证据复核 | accepted / corrected / rejected |
| `takeover` | 人暂时接管浏览器，完成后交还 | 新 PageEpoch 和上下文快照 |
| `escalation` | 当前处理人超时或权限不足 | 新处理人或终止决定 |

候选 `HumanTask` 至少需要：

- `task_id`、`run_id`、`node_execution_id` 和创建时的 revision。
- 任务类型、严格输入/输出 Schema、展示摘要和脱敏证据引用。
- 指派范围、截止时间、提醒和升级规则。
- `resume_token`、一次性提交和 CAS。
- 完成、拒绝、超时、取消、失效五类明确结果。
- 浏览器接管后重新验证 TabRef、PageEpoch、Origin、账号和店铺身份。

人工作业可以跨 Core、Chrome 重启持续存在，但不能在原页面上下文已经变化后
直接继续执行写操作。

### 2.4 等待、外部系统和长事务

等待必须持久化，不占用线程或浏览器连接：

- `TimerWait`：等待到绝对时间或一段持续时间。
- `EventWait`：等待带相关键的 Inbox 事件。
- `BrowserWait`：等待页面恢复、导航完成或用户重新连接。
- `HumanWait`：等待 HumanTask 终态。

每个 Wait 都要声明截止时间、超时路由、取消行为和恢复条件。外部回调至少一次
投递，由 Inbox 幂等消费；不能把 HTTP 连接保持到流程结束。

### 2.5 数据和文件

初始通用能力还应逐步覆盖：

- validate、select、merge、filter、map、group、sort、dedupe 和 join。
- JSON/CSV/XLSX 的受约束读写。
- 文件选择、下载完成、摘要校验、大小和 MIME 限制。
- Run 变量、局部作用域、秘密引用和证据引用。
- 批次的成功项、失败项、跳过项和不确定项，而不只返回一个布尔值。

数据节点保持确定性、无网络和无任意代码。大数据不直接写入 Event payload，
而是写 Evidence/Object Store，事件只保存摘要和引用。

### 2.6 浏览器场景

浏览器能力应按语义而不是鼠标动作分层：

- 上下文：选择/绑定 tab、frame、profile、账号、店铺和 PageEpoch。
- 读取：文本、结构化字段、表格、状态和页面能力。
- 断言：页面身份、元素唯一性、业务前置条件和写后状态。
- 导航：受允许 Origin 和路由约束的打开、返回和等待。
- 写入：输入、选择、切换、上传和保存预检。
- 证据：局部 DOM 摘要、截图、下载文件和写前/写后对比。

验证码、登录失效、限流、风控提示和页面结构未知必须返回阻断信号。拟人化节奏
只用于稳定性和平台友好，不用于规避验证码、防爬或访问控制。

### 2.7 恢复与运维

需要覆盖的非理想情况包括：

- Core、Native Host、Extension、浏览器或页面任一端重启。
- 命令已执行但 Result 未确认。
- 人工接管时页面跳转、账号切换或 tab 被关闭。
- 批次中部分项目失败。
- Workflow 或 Node 新版本发布，但旧 Run 尚未完成。
- 外部系统迟到、重复、乱序或永久不响应。
- 写操作效果未知，必须进入 `uncertain`。
- 升级或 Migration 失败，需要保持旧 Runtime 可启动。

恢复策略必须显式选择 resume、retry、skip、replay、compensate、manual review
或 terminate，不能用一个通用“继续”按钮掩盖不同语义。

## 3. 结构化循环模型

### 3.1 为什么不能直接允许图回边

当前 Node 执行身份主要由 Run、Node key 和 attempt 构成。任意回边会让同一 Node
被多次访问，破坏幂等键、事件顺序、恢复位置和证据归属。它还可能形成无法在
编译期证明有界的循环。

结构化循环需要增加执行作用域：

```text
run_id
└── scope_id: foreach:products
    ├── iteration_id: product:123
    │   ├── node_execution: read
    │   └── node_execution: validate
    └── iteration_id: product:456
        ├── node_execution: read
        └── node_execution: validate
```

候选执行身份为：

```text
run_id + scope_path + iteration_key + node_key + attempt
```

每个循环必须声明：

- 集合或 cursor 来源。
- `max_items` / `max_pages` / `max_iterations`。
- `max_total_duration_ms`。
- 稳定且唯一的 `iteration_key`。
- 单项失败策略：stop、continue、collect 或 manual。
- 并发上限；浏览器循环 v1 默认 `1`。
- 每次迭代的输入、局部输出和聚合输出 Schema。
- `uncertain` 默认立即停止，不进入下一项。

### 3.2 推荐落地顺序

1. `foreach`：只处理运行开始时已确定的有限数组。
2. `poll`：只读 Node + 条件 + 退避 + 总时限。
3. `paginate`：加入 cursor 唯一性和最大页数。
4. `subworkflow`：复用经过发布的流程片段。
5. `parallel`：完成资源租约和聚合语义后再开放。
6. `repeat`：只有真实场景无法表达为以上原语时才开放。

## 4. 工程目录闭环

### 4.1 当前立即生效的闭环

仓库统一以 `pnpm verify` 作为本地、CI 和打包前验收入口：

```text
schema:check
→ repository:check
→ scripts:check
→ typecheck
→ test
→ build
→ docs:check
```

`repository:check` 负责补足普通单元测试没有覆盖的仓库级不变量：

- Runtime 版本在根包、应用、源代码和安装脚本中一致。
- Node / Workflow 文件名、身份、版本和引用一致。
- 默认资产没有被误删，示例 Workflow 不引用未知 Node。
- Skill frontmatter、UI metadata、引用文件和禁用占位词有效。
- 运维 shell 脚本保持可执行。

正式资产闭环应保持：

```text
Schema
→ generated types
→ Catalog source
→ compiler
→ contract tests
→ Candidate
→ human publish
→ immutable artifact
→ package
→ install / migrate
→ real validation
→ event / evidence / audit
```

### 4.2 目标目录

不为了目录整齐立即搬迁稳定代码。新增能力落地时逐步形成以下结构：

```text
adapters/<platform>/
├── src/
├── page-models/       # 已审核的语义页面模型
├── fixtures/          # 脱敏页面夹具
├── contracts/         # ElementContract 与能力契约测试
└── replays/           # 脱敏的发现/执行回放

workflows/
├── examples/          # 最小可运行样例
├── templates/         # 参数化创作模板
└── scenarios/         # 真实业务候选和验收数据

tests/
├── conformance/       # Schema、Persistence、Protocol 实现一致性
├── integration/       # Core / Engine / Gateway 边界
├── e2e/               # Chrome for Testing 与真实人工验收入口
├── replay/            # 页面和协议回放
└── fixtures/

skills/
├── bpa-workflow-authoring/
├── bpa-node-authoring/
└── bpa-runtime-diagnostics/
```

进入正式创作协议后再评估新增：

- `packages/authoring-model`：ScenarioSpec、Draft Graph、Gap Report。
- `packages/page-model`：PageModel、ElementContract 和快照比对。
- `packages/workflow-draft`：增量草稿操作、冲突检测和 Candidate 固化。

### 4.3 后续工程门禁

- 每个 Schema 变更都需要兼容性说明、生成物检查和迁移测试。
- 每个 Node 都需要契约、幂等、取消、权限和错误码测试。
- 每个 Adapter 都需要至少两个页面状态夹具和一次变化回放。
- 每个 Workflow 都需要成功、业务失败、超时和人工/不确定路径。
- 安装包需要清单、摘要、Runtime 版本、Migration 目标和回滚入口。
- Release 必须从干净提交构建，并记录提交摘要和验证结果。
- Chrome for Testing 负责可重复 E2E；真实 Chrome 只承担登录态人工验收。

## 5. AI 快速编写 Workflow

### 5.1 核心原则

Workflow 只描述“调用哪个业务能力以及怎么路由”，不保存 CSS、XPath、坐标、
JavaScript 或页面文案。元素定位属于 Browser Node 对应 Adapter 的 PageModel。

这使 AI 可以优先复用稳定的语义能力：

```yaml
node_ref: doudian.product.title.read@1.0.0
```

而不是每次重新生成：

```text
找到第三个 div 下的第二个 span，然后读 innerText
```

### 5.2 三阶段创作

#### 阶段一：意图结构化

AI 先把自然语言转换为候选 `ScenarioSpec`：

- 业务目标和成功标准。
- 触发方式和输入/输出。
- 页面、账号、店铺和数据范围。
- 是否写入、最高风险和允许的人工步骤。
- 批量、等待、循环和时限需求。
- 必须保留的证据。

#### 阶段二：语义能力匹配

`catalog_search_v2` 不应只做文本包含，应按以下维度排序：

- capability / verb / object / domain。
- 输入输出 Schema 可兼容性。
- Browser/API/Human/Engine 执行位置。
- risk、permission、idempotency 和 evidence。
- 平台、页面模型版本和最近验证时间。
- 同义词、模板和已成功 Workflow 的组合片段。

AI 优先搜索 Recipe 和 Workflow Template，再组合 Node。找不到能力时输出明确
`CapabilityGap`，而不是把页面选择器塞进 Workflow。

#### 阶段三：增量草稿

复杂 Workflow 不宜由一次 `workflow_gen` 返回完整大 JSON。候选工具应支持：

- `workflow_draft_create`
- `workflow_draft_get`
- `workflow_node_add` / `workflow_node_configure`
- `workflow_edge_set`
- `workflow_test_add`
- `workflow_validate`
- `workflow_simulate`
- `workflow_candidate_save`

每次操作返回 revision、局部 diff、当前错误和待解决缺口。AI 可以小步修复，
用户也能看懂每一步变化。最终 Candidate 仍需人工发布。

### 5.3 页面元素预定位

预定位是 Node/Adapter 创作过程，不是正常 Workflow 运行能力。建议引入显式、
只读、短时的 `AuthoringSession`：

```text
User enables Design Mode
→ bind exact Chrome profile / tab / origin
→ capture redacted PageSnapshot
→ search semantic element candidates
→ generate ElementContract candidate
→ validate across states and fixtures
→ human review
→ Adapter + Node Candidate
```

候选创作工具：

- `authoring_session_start` / `authoring_session_stop`
- `page_probe`
- `element_search`
- `element_contract_generate`
- `element_contract_validate`
- `page_fixture_capture`
- `adapter_probe_validate`

`AuthoringSession` 默认应满足：

- 用户显式开启并显示持续状态，TTL 到期自动关闭。
- R0 只读，固定 Extension、profile、tab 和精确 Origin。
- 不接受远程脚本、任意 JavaScript、通用 evaluate 或正常运行命令。
- DOM 先在扩展侧裁剪和脱敏，再以 Evidence 分块传输。
- 密码、token、cookie、隐藏输入、个人信息和大文本默认移除。
- 所有快照、候选和确认动作进入 Audit。

### 5.4 ElementContract 候选结构

以下只是讨论稿，不是正式 Schema：

```yaml
element_id: product.save
intent: 保存当前商品编辑
scope:
  origins: [https://fxg.jinritemai.com]
  path_pattern: /ffa/g/create
  page_state: product-edit-ready
  frame: top
expected_count: 1
candidates:
  - strategy: business-id
    value: product-save
  - strategy: role-name
    role: button
    name: 保存
  - strategy: relative-anchor
    anchor: form-actions
    role: button
    name: 保存
preconditions:
  - page_identity_confirmed
  - form_not_submitting
postconditions:
  - save_result_visible
volatility: medium
```

定位候选优先级：

1. 平台稳定业务 ID 或已审核 `data-*`。
2. 无障碍 role + 可稳定名称。
3. label、name、href 语义和结构化属性。
4. 相对稳定语义锚点。
5. CSS 仅作为诊断候选。

默认拒绝绝对 XPath、深层 `nth-child`、屏幕坐标和只依赖易变文案的定位。
ElementContract 需要在至少两种代表性页面状态或脱敏快照上验证唯一性；写节点
还需要前置状态、写后断言和页面变化时的 fail-closed 行为。

### 5.5 AI 的最终交付物

一次完整创作不只输出 Workflow YAML，还应输出：

- ScenarioSpec 和假设。
- 选用 Node 及版本依据。
- 执行图和数据绑定。
- 权限并集、风险和人工边界。
- 成功、失败、超时、取消和 `uncertain` 测试。
- CapabilityGap / ElementContract 候选。
- 与旧版本的语义 diff。
- 仍需人工确认的页面身份和发布事项。

## 6. 实施顺序

### 0.3.1：工程与创作基线

- 统一 `pnpm verify`。
- 固化仓库不变量检查。
- 补强 Workflow / Node Authoring Skills。
- 形成本文的需求分类和候选边界。

### 0.4：可中断执行

- `SingleNodeRun`。
- 通用 HumanTask：approval、input、action、review。
- `TimerWait` / `EventWait`。
- Run 变量、作用域和明确 resume 语义。

### 0.5：AI 创作会话

- ScenarioSpec、CapabilityGap 和增量 Workflow Draft。
- Catalog 结构化搜索和 Recipe。
- 只读 AuthoringSession、PageSnapshot 和 ElementContract。
- PageModel 夹具、回放和变化检测。

### 0.6：结构化复用与循环

- `foreach` 和 `poll`。
- Subworkflow。
- Batch Run 和人工干预队列。
- 验证稳定后再讨论 paginate、parallel 和补偿组。

## 7. 正式化前需要确认

进入代码和 Schema 前，需要共同确认以下四组协议：

1. HumanTask 的类型、提交身份、超时和接管恢复语义。
2. Iterate 的作用域身份、上限、聚合和 `uncertain` 行为。
3. AuthoringSession 的授权方式、TTL、脱敏和证据保留策略。
4. PageModel / ElementContract 的定位优先级、版本与失效判定。

确认后应先提交 Schema、状态机、示例和兼容性规则，再实现运行时能力。
