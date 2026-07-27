# BPA 技术架构草案 v0.1

> 状态：历史讨论稿，已由 [`BPA 通用技术方案 v1.0`](BPA通用技术方案-v1.0.md) 取代，不作为实现依据
> 阶段判断：BPA 已在一个真实场景中解决问题，但仍处于从单点方案提炼通用体系的早期阶段。

## 1. 这版设计要回答的问题

1. Codex 如何把业务描述转换成可执行的 Workflow。
2. Workflow 应该用什么结构表达。
3. 哪些节点可以通用，哪些能力允许自定义。
4. 如何保证 AI 生成的流程不会直接变成不受约束的浏览器代码。
5. 如何暂停、恢复、重试、验证、审计和发布 Workflow。
6. 早期原型应该选什么技术，哪些复杂系统应该推迟引入。

## 2. 核心判断

### 2.1 `workflow_gen` 是必要能力，但不应该只是一个“生成 JSON”的函数

`workflow_gen` 应当是一套面向 Codex 的 Workflow 工程能力：

```text
业务目标
  ↓
Workflow 草稿
  ↓
Schema 校验
  ↓
节点和权限检查
  ↓
静态分析
  ↓
测试用例 / 页面快照模拟
  ↓
人工审核
  ↓
版本发布
```

Codex 负责理解需求、选择节点、生成草稿和解释差异。确定性的编译器、校验器和测试器负责判断草稿是否有资格进入运行环境。

因此建议把 Codex 接入分成两层：

- **BPA Workflow Authoring Skill**：告诉 Codex 如何访谈业务、识别输入输出、选择节点、补充异常分支、生成测试和解释风险。
- **BPA MCP Server**：向 Codex提供确定性工具，例如读取节点目录、创建草稿、校验、模拟、比较和发布。

Skill 是生成方法，MCP Tools 是实际能力。正式 Workflow 不应只保存在 Skill、提示词或聊天记录中。

### 2.2 Workflow 是声明式业务图，不是脚本

Workflow 应描述：

- 要达到的业务结果。
- 输入、输出和约束。
- 节点及节点之间的数据流和控制流。
- 每个动作的前置条件和后置验证。
- 重试、超时、补偿、人工接管和审批策略。
- 使用的节点类型及其固定版本。

Workflow 不允许包含任意 JavaScript、`eval`、动态远程代码或未经注册的浏览器动作。

### 2.3 自定义节点是受治理的扩展点

自定义节点不等于“把一段代码塞进 Workflow”。它应当是一个提前注册、测试、签名和版本化的能力包。Workflow 只能引用：

```text
node_type: company.profit.calculate
node_version: 1.2.0
```

而不能内嵌：

```text
code: "在浏览器中执行任意 JavaScript"
```

## 3. 总体架构

```text
人 / Codex
    │
    ├── BPA Authoring Skill
    │
    └── BPA MCP Server
             │
             ▼
      Workflow Studio / API
             │
       ┌─────┴─────────┐
       ▼               ▼
Workflow Registry   Compiler & Validator
       │               │
       └──────┬────────┘
              ▼
        Workflow Engine
        │      │       │
        │      │       └── Human Task / Approval
        │      └────────── Node Runtime
        └───────────────── Browser Gateway
                                  │
                                  ▼
                         Chrome Extension
                         ├─ Side Panel
                         ├─ Service Worker
                         └─ Content Scripts

所有执行事件 ──→ Event Log / Evidence Store / Audit
```

### 3.1 Workflow Registry

保存不可变的 Workflow 版本：

- `draft`：可编辑。
- `validated`：已通过静态检查。
- `tested`：已通过规定测试。
- `approved`：负责人已批准。
- `published`：可供任务运行。
- `deprecated`：不再创建新任务，但历史任务仍可回放。

已发布版本不可原地修改，只能复制为新草稿并发布新版本。

### 3.2 Compiler & Validator

负责把人或 Codex 编写的 DSL 编译成引擎可执行的内部表示，并执行：

- JSON Schema 校验。
- 节点类型、版本和参数校验。
- 输入输出端口类型检查。
- 不可达节点、死路和无限循环检查。
- 缺少成功验证的浏览器写操作检查。
- 未处理的错误出口检查。
- 风险动作缺少审批点检查。
- 权限范围和域名检查。
- Secret 误写入 Workflow 检查。
- 自定义节点依赖和兼容性检查。

### 3.3 Workflow Engine

引擎只执行已发布的 Workflow，职责包括：

- 持久化状态机。
- 调度节点。
- 保存每一次状态转换。
- 节点级超时、重试和幂等。
- 暂停、恢复、取消。
- 浏览器断线后重新连接。
- 等待人工确认或人工输入。
- 固定运行中的 Workflow 和节点版本。
- 生成最终结果和审计记录。

### 3.4 Browser Gateway 与浏览器扩展

Gateway 管理任务和真实浏览器会话之间的连接。扩展负责：

- 使用用户当前登录状态。
- 生成语义 DOM。
- 对节点引用进行短期解析。
- 校验页面 URL、页面版本、元素可见性和可操作性。
- 执行有限动作。
- 返回动作前后证据。

扩展不持有完整业务流程，也不负责决定下一个业务步骤。

## 4. Workflow DSL

### 4.1 建议格式

- **作者界面**：YAML，便于人和 Codex阅读、生成及评审。
- **传输与存储规范**：JSON。
- **Schema**：JSON Schema Draft 2020-12。
- **内部执行格式**：编译后的不可变 JSON IR。

YAML 只是 JSON 的作者层表示，不支持自定义 YAML Tag、函数或模板代码。

### 4.2 Workflow 顶层结构

```yaml
apiVersion: bpa/v1alpha1
kind: Workflow
metadata:
  id: order.export
  version: 0.1.0
  title: 导出指定日期的已完成订单

spec:
  riskLevel: low
  inputSchema:
    type: object
    required: [date, status]
    properties:
      date:
        type: string
        format: date
      status:
        type: string
        enum: [completed, pending]

  outputSchema:
    type: object
    required: [file]
    properties:
      file:
        type: string
      rowCount:
        type: integer

  start: open_order_page

  nodes:
    open_order_page:
      use: browser.navigate@1
      with:
        url: https://example.com/orders
      next: wait_for_table

    wait_for_table:
      use: browser.wait_for@1
      with:
        target:
          role: table
          name: 订单列表
        timeout: 15s
      on:
        success: set_filters
        timeout: request_human

    set_filters:
      use: browser.form.fill@1
      with:
        fields:
          - target: { label: 开始日期 }
            value: "${{ input.date }}"
          - target: { label: 订单状态 }
            value: "${{ input.status }}"
      verify:
        - use: browser.assert.form_value@1
          with:
            label: 订单状态
            equals: "${{ input.status }}"
      next: export

    export:
      use: browser.download@1
      with:
        target: { role: button, name: 导出 }
      verify:
        - use: browser.assert.download@1
          with:
            fileType: xlsx
            within: 30s
      retry:
        maxAttempts: 2
        backoff: 2s
      next: finish

    request_human:
      use: human.request@1
      with:
        reason: 订单列表未在规定时间内出现

    finish:
      use: control.succeed@1
      with:
        output:
          file: "${{ nodes.export.output.file }}"
          rowCount: "${{ nodes.export.output.rowCount }}"
```

### 4.3 两种连线需要分开

- **控制流**：节点成功、失败、超时或某一条件下走到哪里。
- **数据流**：节点输入从 `input`、`context` 或此前哪个节点输出取得。

不要仅依赖画布中的连线推断数据来源。所有数据引用都应显式、可类型检查。

### 4.4 表达式语言

第一阶段只实现安全的只读表达式：

```text
input.date
context.shopId
nodes.query.output.items
length(nodes.query.output.items)
```

支持属性读取、布尔比较、空值处理和少量纯函数。不支持循环、网络、文件、日期隐式运算和任意代码执行。

复杂确定性计算应放入注册节点，而不是逐步扩张表达式语言。

## 5. 节点体系

### 5.1 节点统一契约

每个节点类型必须提供：

```yaml
type: browser.click
version: 1.0.0
runtime: browser
inputSchema: {}
outputSchema: {}
configSchema: {}
risk:
  level: low
  permissions: [browser.dom.write]
execution:
  timeoutDefault: 10s
  idempotency: conditional
  retryableErrors: [TARGET_STALE, PAGE_LOADING]
evidence:
  required: [before, after]
```

节点运行结果统一为：

```text
succeeded | failed | timed_out | waiting | cancelled | skipped
```

失败需要结构化错误码，而不仅是一段文本：

```text
TARGET_NOT_FOUND
TARGET_AMBIGUOUS
TARGET_STALE
PAGE_MISMATCH
PERMISSION_DENIED
VALIDATION_FAILED
BROWSER_DISCONNECTED
HUMAN_REJECTED
```

### 5.2 第一批通用节点

#### 控制节点

- `control.start`
- `control.succeed`
- `control.fail`
- `control.condition`
- `control.switch`
- `control.foreach`
- `control.parallel`
- `control.join`
- `control.wait`
- `control.try`
- `control.subworkflow`

第一版可先不实现自由循环，只实现有最大数量限制的 `foreach`，避免无限执行。

#### 浏览器观察节点

- `browser.observe`
- `browser.extract.text`
- `browser.extract.table`
- `browser.assert.visible`
- `browser.assert.text`
- `browser.assert.url`
- `browser.assert.form_value`
- `browser.assert.download`

#### 浏览器动作节点

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

动作节点和验证节点分开建模；便捷节点可以组合两者，但编译后仍应展开为动作与验证。

#### 数据节点

- `data.map`
- `data.filter`
- `data.pick`
- `data.merge`
- `data.validate`
- `data.csv.parse`
- `data.table.normalize`

#### 系统节点

- `http.request`：仅允许白名单域名和已登记凭证。
- `file.inspect`
- `file.save`
- `secret.get`：返回句柄或受保护值，审计中必须脱敏。

#### 人工节点

- `human.approve`
- `human.request`
- `human.input`
- `human.takeover`

### 5.3 自定义节点的三种级别

#### A. 组合节点

用已有通用节点封装一个业务能力，例如“设置订单筛选条件”。它本身不引入新代码，是最优先的自定义方式。

#### B. 服务端代码节点

用于利润计算、数据清洗、内部 API 等确定性能力。实现为经过注册的 TypeScript 包或独立服务：

- 固定版本。
- 固定输入输出 Schema。
- 无默认浏览器权限。
- 独立测试。
- 超时和资源限制。
- 发布前审核。

#### C. 浏览器能力节点

只有通用 DOM 动作确实无法表达时才添加，例如某个平台的复杂日期控件适配器。它必须随扩展版本发布，不能由 Workflow 动态下发代码。

## 6. `workflow_gen` 的产品形态

不建议只暴露一个超大工具。建议对 Codex提供以下 MCP Tools：

```text
workflow_requirements_analyze
node_catalog_search
workflow_draft_create
workflow_draft_update
workflow_validate
workflow_simulate
workflow_test_generate
workflow_diff
workflow_submit_for_review
workflow_publish
execution_replay
```

其中高风险或正式状态变化要分离：

- `create/update/validate/simulate` 可以由 Codex自动调用。
- `submit_for_review` 是明确动作。
- `publish` 必须检查审批凭证，不能因为 Codex 调用了工具就自动通过。

### 6.1 推荐生成流程

1. 读取业务目标和已有成功案例。
2. 生成 Requirements：
   - 输入、输出、验收标准。
   - 目标系统、页面和角色。
   - 风险动作。
   - 已知异常。
3. 查询 Node Catalog，优先复用已有节点。
4. 缺少能力时，先尝试组合节点，再提出自定义节点 RFC。
5. 生成 Workflow 草稿。
6. 静态校验并根据错误修复。
7. 从成功案例和异常案例生成测试。
8. 在页面快照或测试环境中模拟。
9. 输出人类可读的流程摘要、风险摘要和版本差异。
10. 人工批准后发布。

### 6.2 `workflow_gen` 的输出不能只有 Workflow

一次生成应同时产生：

- `workflow.yaml`
- `requirements.md`
- `tests/*.yaml`
- `risk-assessment.md`
- `generation-report.json`

`generation-report.json` 记录：

- 使用了哪些业务证据。
- 哪些地方是确定事实。
- 哪些地方是 Codex 的推断。
- 哪些节点被复用。
- 哪些能力缺失。
- 哪些地方仍需人工确认。

### 6.3 `node_gen` 与能力缺口闭环

通用化之后还需要独立的 `node_gen`。它与 `workflow_gen` 的关系是：

```text
workflow_gen 查询 Node Catalog
        │
        ├─ 能力满足：组合并生成 Workflow
        │
        └─ 能力缺失：生成 Node Requirement
                          │
                          ▼
                       node_gen
                          │
                          ▼
              候选节点、测试、权限和审核材料
                          │
                          ▼
                 审核后发布到 Node Catalog
                          │
                          └─→ workflow_gen 重新生成
```

`workflow_gen` 不允许在能力不足时生成临时代码绕过 Node Catalog。

`node_gen` 优先生成组合节点；确实需要新代码时，才生成 Engine 节点或 Browser Adapter 节点的候选实现。所有候选节点必须经过 Schema 校验、契约测试、页面夹具测试、安全检查和人工审核，才能作为固定版本发布。

建议对 Codex 暴露：

```text
node_catalog_search
node_requirement_create
node_candidate_generate
node_validate
node_test
node_diff
node_submit_for_review
node_publish
```

`node_publish` 必须检查外部审批，不能由生成节点的 Codex 自己批准。

## 7. 执行语义

### 7.1 事件溯源

每次运行保存追加式事件：

```text
RUN_CREATED
NODE_SCHEDULED
NODE_STARTED
ACTION_REQUESTED
ACTION_ACCEPTED
ACTION_REJECTED
NODE_SUCCEEDED
NODE_FAILED
RUN_PAUSED
HUMAN_APPROVED
RUN_COMPLETED
```

当前状态由事件归约得到。这样可以恢复任务、解释失败、生成审计记录和回放测试。

### 7.2 幂等

每个节点执行使用：

```text
idempotency_key = run_id + node_id + iteration + attempt_policy
```

浏览器写操作不能默认安全重试。例如“点击导出”可以通过下载证据判断是否已经完成；“点击退款”没有确认业务状态前不能自动重试。

### 7.3 页面目标

Workflow 保存语义目标，不保存一次性的 DOM 节点 ID：

```yaml
target:
  role: button
  name: 导出
  within:
    role: region
    name: 订单列表
```

运行时扩展根据当前页面生成候选并返回：

- 匹配置信度。
- 唯一性。
- 可见性。
- 可用性。
- 页面版本。
- 短期节点令牌。

如果匹配不唯一或页面版本变化，扩展拒绝动作，引擎选择重新观察、允许的恢复分支或人工接管。

## 8. 技术选型建议

### 8.1 第一阶段推荐栈

| 层 | 推荐 |
|---|---|
| 语言 | TypeScript |
| 仓库 | pnpm workspace monorepo |
| Workflow Schema | JSON Schema 2020-12 |
| Schema 校验 | Ajv |
| API | Fastify 或 Hono，优先 Fastify |
| 数据库 | 原型 SQLite，进入多人/多任务后 PostgreSQL |
| ORM/查询 | Drizzle |
| 浏览器扩展 | Chrome Manifest V3 + TypeScript |
| Side Panel | React + Vite |
| 引擎 | 自研小型持久化状态机 + 事件日志 |
| Codex 接入 | Repo Skill + 本地 BPA MCP Server |
| 日志 | 结构化 JSON 日志 |
| 可观测性 | OpenTelemetry，原型阶段先保留接口 |
| 测试 | Vitest + Playwright + 固定页面夹具 |

选择 TypeScript 是为了让 Schema、节点 SDK、引擎、MCP Server、扩展和管理界面共享类型与工具链。

### 8.2 为什么第一版不直接上 Temporal

Temporal 很适合长时间运行、故障恢复和分布式任务，但它的 Workflow 是代码，并有自己的确定性执行模型。BPA 当前最需要验证的是 DSL、节点抽象、页面执行和业务价值，而不是先解决大规模分布式调度。

建议：

- 第一版实现很小的事件驱动执行器。
- 从一开始把 Engine 接口和事件模型设计清楚。
- 当出现多 Worker、跨天任务、大量并发、复杂定时器或自研恢复成本明显增加时，再把调度层迁移到 Temporal。
- 即使以后使用 Temporal，BPA Workflow DSL 和 Registry 仍是上层资产，不能直接退化成散落的 Temporal 业务代码。

### 8.3 XState 的位置

XState 适合：

- Side Panel 的交互状态。
- Workflow 编辑器的局部状态。
- 单个节点或短生命周期任务的状态建模。

不建议第一版把 XState 的机器定义直接作为 BPA 的公开 Workflow 格式，也不建议只依赖内存 Actor 作为持久化引擎。

### 8.4 扩展通信

原型阶段：

- 本地 BPA 服务通过 loopback WebSocket 与扩展通信。
- 每个连接使用一次性配对令牌和会话密钥。
- 扩展主动连接，服务端不能任意控制未配对浏览器。
- Content Script 只接收来自扩展 Service Worker 的结构化动作。

后续如需企业部署，再评估 Native Messaging、设备身份和集中式 Gateway。

## 9. 推荐仓库结构

```text
bpa/
├── apps/
│   ├── api/
│   ├── studio/
│   ├── extension/
│   └── worker/
├── packages/
│   ├── workflow-schema/
│   ├── workflow-compiler/
│   ├── workflow-engine/
│   ├── node-sdk/
│   ├── node-catalog/
│   ├── browser-protocol/
│   ├── evidence/
│   └── shared/
├── nodes/
│   ├── core/
│   └── custom/
├── workflows/
│   └── examples/
├── .agents/
│   └── skills/
│       └── bpa-workflow-authoring/
├── tests/
│   ├── fixtures/
│   ├── workflow/
│   └── browser/
└── docs/
```

## 10. 实施顺序

### Phase 0：复盘已经成功的场景

不要先做通用编辑器。先把已有场景整理为：

- 原始业务目标。
- 实际输入输出。
- 稳定步骤。
- 临时处理。
- 异常和人工判断。
- 页面证据。
- 哪些部分真正可复用。

这会成为第一份 Workflow、第一批节点和第一组测试。

### Phase 1：Workflow 内核

只实现：

- Workflow Schema。
- Node Definition Schema。
- 10 个左右必要节点。
- Compiler / Validator。
- YAML 到 IR。
- CLI：`validate`、`compile`、`test`。

### Phase 2：可执行闭环

- 小型 Engine。
- SQLite Event Log。
- 浏览器扩展。
- 单个真实 Workflow。
- 暂停、恢复、证据和人工接管。

### Phase 3：Codex 生成闭环

- BPA Authoring Skill。
- 本地 MCP Server。
- 节点目录查询。
- 草稿生成、校验、模拟和 diff。
- 人工审核发布。

### Phase 4：验证复用性

选择第二个相邻场景。核心指标不是第二个场景能否完成，而是：

- 复用了多少节点。
- 新增了多少平台特定节点。
- Workflow 定制花了多久。
- 页面异常能否正确停止和归因。
- Codex 生成后需要多少人工修正。

## 11. 当前最关键的产品指标

- 从业务描述到首个可测试 Workflow 的时间。
- 第二个相邻 Workflow 的复用率。
- Workflow 一次通过静态校验的比例。
- 浏览器写动作具备后置验证的比例。
- 错误元素操作率。
- 异常归因准确率。
- 平均人工接管次数。
- Workflow 从草稿到发布所需的人类修改量。
- 已发布 Workflow 在 AI 不可用时能否由人直接运行。

## 12. 近期需要做出的设计决策

1. 已成功的第一个场景到底是什么，以及完整操作证据是否还在。
2. Workflow 第一版需要支持 DAG，还是顺序步骤加条件分支已经足够。
3. 第一版是否需要 `foreach`、并行和子流程。
4. 浏览器扩展只服务 Chrome，还是一开始考虑多浏览器。
5. BPA 服务第一阶段运行在用户电脑，还是公司服务器。
6. 自定义节点第一阶段只支持组合节点，还是同时开放服务端 TypeScript 节点。
7. 谁拥有 Workflow 发布权限，审核以什么证据为准。

## 13. 暂定结论

BPA 的最小技术内核不应是“AI 操作浏览器”，而应是：

```text
受约束的 Workflow DSL
+ 可版本化的节点目录
+ 可恢复的确定性执行器
+ 真实浏览器中的安全动作端
+ 证据与人工治理
+ Codex 辅助的 Workflow 工程工具
```

`workflow_gen` 是重要入口，但真正建立壁垒的是生成之后的校验、模拟、证据、版本和复用机制。

## 14. 技术参考

- [Codex Skills](https://learn.chatgpt.com/docs/build-skills)：用可复用说明、脚本和参考资料定义 Workflow 作者能力。
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)：向 Codex 暴露外部工具、资源和受控动作。
- [JSON Schema 2020-12](https://json-schema.org/specification)：Workflow、节点和参数的结构化校验标准。
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)：扩展中的持续任务界面。
- [Temporal](https://docs.temporal.io/)：后续需要分布式、长时间和高可靠执行时的候选调度底座。
- [XState](https://stately.ai/docs/xstate)：适用于局部交互和状态机建模，但不作为第一版公开 DSL。
