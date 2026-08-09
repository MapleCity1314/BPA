# BPA 抖店体验分采集工作流接管计划 v0.1

> 文档类别：公司业务工作流迁移计划。  
> 记录时间：2026-08-07。  
> 实现状态：部分实现；P1 与正式资产本机 Provider E2E 已完成，尚未执行真实浏览器 E2E、
> 单店事实持久化、Dataset、外部投递、部署或调度切换。
> 适用范围：公司 Mac mini 上的抖店体验分每日多店采集。  
> 不在本期：微信小店、快手小店、历史数据兼容层、Rust 改写。  
> 权威上位文档：`docs/normative/bpa-product-form-v1.md`、
> `docs/normative/bpa-roadmap-v1.md`、
> `docs/plans/deterministic-workflow-triggering-v0.1.md`。

## 0. 决策摘要

抖店体验分采集可以接入 BPA，并应作为库存、清退商品、爆款图片之后的第四条生产迁移链。
它能验证 BPA 对“每日定时、多店浏览器只读采集、逐店持久化、部分成功、证据、告警和
外部投递”的完整支持。

接管不采用“Node 调旧 `.command`”的壳方案。目标是把现有 Python + Playwright/CDP
行为拆成正式 Adapter、Node、Workflow、Trigger 和 Effect Node，并纳入统一租约、运行
终态、证据和控制台。

本计划作出以下决定：

1. 第一批只迁移抖店，微信小店和快手小店继续按现有路径运行。
2. Mac 正式部署只保留一个 BPA 管理的抖店 Chrome 实例与 Profile；不为库存、清退商品、体验分分别常驻 Chrome。
3. 所有抖店工作流共享“抖店账号浏览器控制”并发键和同一 `browserInstanceId`，禁止两个控制面同时操作。
4. 生产主事实写入 BPA；飞书多维表和消息降级为独立、受审计的外部投递。
5. 历史文件保持只读归档；不建立旧 Excel、旧 Run JSON 或旧 SQLite 的运行时兼容层。
6. 首版复用 Operator Console 的通用 Run、Dataset、Evidence、Alert 视图，不扩展
   `apps/inventory-monitor`，也不为单一业务修改 Core/Compiler/Schema 通用语义。
7. 只有新工作流通过真实登录页、13 店覆盖、外部投递和连续生产窗口门禁后，才移除旧
   抖店调度与代码路径。

## 1. 只读生产审计基线

以下信息是 2026-08-07 14:57–15:01 CST 的只读快照，只作为迁移依据，不代表未来持续状态。

### 1.1 当前生产拓扑

```text
launchd: com.juan.experience-score.daily
  → /bin/zsh
  → 自动采集_三平台_每天13点.command
  → Python CLI: dy_experience_bot
  → Playwright connect_over_cdp
  → 三个独立 Chrome for Testing Profile
      抖店  : 127.0.0.1:9222
      微信  : 127.0.0.1:9333
      快手  : 127.0.0.1:9444
  → Excel / Run JSON / 截图 / Markdown 报告
  → 飞书多维表与消息
```

生产目录：

```text
/Users/Shared/ecom-profit/projects/experience-score-collection
```

另有一份开发副本：

```text
/Users/yyerybz/Codex/巡店检查/体验分采集项目
```

两个目录均不是 Git 仓库，不能从版本控制证明生产文件与开发文件一致。

### 1.2 当前调度与运行证据

| 项目 | 只读观测 |
| --- | --- |
| 每日 Trigger | launchd 每天 13:00 |
| 月度归档 | 每月 1 日 15:30 |
| 2026-08-07 抖店 | 13/13 成功；Run 状态 `success` |
| 2026-08-07 微信小店 | 5/5 成功 |
| 2026-08-07 快手小店 | 4/4 成功 |
| 当日整轮时间 | 13:00:01–13:54:59 |
| 抖店外部投递 | 飞书多维表同步成功，日报消息发送成功 |
| 抖店配置 | 12 家静态配置并启用自动发现，当日实际发现并完成 13 家 |
| 月度归档库 | 10 次归档；最新归档时间为 2026-08-01 15:30 CST |

今天的成功证明旧系统仍在工作，不证明它已经满足 BPA 的租约、发布、证据和可交付边界。

### 1.3 当前抖店字段范围

摘要事实：

- 业务日期、采集时间；
- 店铺 ID、店铺名称；
- 行业、近 30 天订单量；
- 页面数据更新时间；
- 总体验分、体验分等级；
- Run ID、触发类型、状态与失败原因。

明细事实：

- 维度名称与维度得分；
- 指标名称、指标值或状态；
- 指标得分、权重、变化、解释；
- 商品、物流和服务体验明细；
- 客服、售后审核、平台求助、响应时长等分子、分母和比率字段；
- 每店 JSON 审计快照和截图证据。

### 1.4 当前资源与库存链关系

体验分使用独立的抖店 Chrome Profile 和 9222 端口。库存使用 BPA 专用 Profile、
Extension 和 17660 端口。二者进程独立，但登录的是同一业务平台，当前没有共同的账号级
并发控制。

2026-08-07 当日：

- 体验分抖店采集运行于 13:00–13:32；
- 库存一轮采集约在 13:28 开始，形成约 4 分钟重叠；
- 该库存轮为部分成功，但现有证据不足以把失败归因于体验分；
- 14:59 库存状态进入 `auth_required`，原因为 `BROWSER_AUTH_REQUIRED`；
- 同日体验分专用 Profile 的 13 店采集成功。

结论是“存在明确并发竞争风险”，不是“体验分已经导致库存故障”。接管前必须消除两个
独立抖店浏览器控制面。

## 2. 现有实现的工程缺口

### 2.1 外层成功不能代表业务成功

三平台脚本会在单平台超时或非零退出后继续运行，最终仍可能由最后一条 `echo` 返回 0。
因此 launchd 的 `last exit code = 0` 不能证明三平台全部成功。真实状态只能从各平台 Run
JSON 和结果记录判断。

### 2.2 缺少统一租约与 fencing

现有 `file_lock.py` 只保护 Excel 文件，并允许按文件年龄清理残留锁。它不能证明：

- 同一平台只有一个浏览器操作者；
- 同一计划时间只有一个有效 Run；
- 旧进程失去所有权后不能继续写结果；
- 外部投递不会在不确定状态下重复发送。

### 2.3 浏览器、采集、报告与投递耦合

当前单个 Collector 同时负责：

- 打开和切换页面；
- 解析业务字段；
- 写 Excel；
- 同步飞书多维表；
- 生成 Markdown 报告；
- 发送飞书消息；
- 写 Run JSON 和截图。

任一后置副作用失败都可能改变整轮状态，且难以独立重放或判断外部效果是否已经发生。

### 2.4 版本与交付不可审计

- 生产目录不是 Git 工作树；
- 开发副本与生产副本没有可验证发布关系；
- 配置、选择器、脚本和 `.bak_*` 文件并存；
- 当前 Run 只保存局部文件指纹，不等于签名 Runtime Closure；
- 公司服务器保留完整源码、虚拟环境、浏览器资料和历史调试资产。

### 2.5 运行资产持续增长

只读观测时项目约 5.8GB，其中抖店 Profile 约 1.5GB、日志约 863MB、归档约 2.3GB。
当前没有由产品统一执行的保留策略、证据固定策略和容量告警。

## 3. 目标与非目标

### 3.1 本期目标

1. 发布一条正式 `doudian.experience-score.daily` Workflow。
2. 使用固定 Schedule Trigger，不依赖 Codex 或人工日常触发。
3. 发现全部可用店铺，逐店读取体验分摘要和明细。
4. 每家店采集成功后立即持久化，不因后续店铺失败丢失已完成事实。
5. 区分 `succeeded`、`partial`、`blocked`、`uncertain`、`failed` 和 `skipped`。
6. 登录、验证码、风控、店铺身份不匹配时安全停止，不自动重试。
7. 将结果、步骤、证据、失败和下一次运行显示在统一 Operator Console。
8. 继续向现有飞书多维表和群消息投递，但将其隔离为有幂等和审计的 Effect Node。
9. 与库存共享抖店账号级浏览器控制租约，消除并行操控。
10. 验收后删除旧抖店采集调度和运行代码，不保留长期双轨。

### 3.2 非目标

- 不同时迁移微信小店和快手小店。
- 不把体验分并入 `apps/inventory-monitor`。
- 不把旧 Python Collector 包成 Shell/Process Node。
- 不复制 Cookie、密码、Token 或 Feishu Secret 到仓库。
- 不合并库存与体验分 Profile，不通过复制浏览器资料迁移登录态。
- 不为该业务修改 Engine、Compiler、通用 Schema 语义或 Persistence 核心。
- 不在本期实现通用 HTTP Request、File Write 或 Excel Export 产品能力。
- 不用 Rust 改写页面采集；该链路主要受浏览器与页面延迟影响。
- 不把历史 Excel/SQLite/Run JSON 接成生产读取回退。

## 4. 目标架构

```text
Operator Console
  ├─ Trigger：每日计划、启停、下一次运行
  ├─ Run：店铺覆盖、步骤、终态、失败分类
  ├─ Dataset：最新体验分与历史版本
  ├─ Evidence：结构化快照、截图、来源页面
  └─ Alert：登录阻断、覆盖不足、投递不确定
                         │
                         ▼
Schedule TriggerSpec（固定 Workflow 版本）
                         │
                account-level concurrency key
                         │
                         ▼
doudian.experience-score.daily Workflow
  ├─ discover_shops
  ├─ foreach shop
  │    ├─ verify_context
  │    ├─ read_snapshot
  │    └─ persist_snapshot immediately
  ├─ aggregate_daily_result
  ├─ release browser control resource
  └─ deliver_feishu effect
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
BPA versioned facts / evidence       Feishu Bitable / Message
（生产主事实）                        （外部投递，不是主事实）
```

### 4.1 浏览器资源决定

首版定义统一资源槽 `doudian_account_browser`，绑定一个 Mac 上长期存活、由 BPA 管理的
Chrome 实例与 Profile，并由 BPA Extension + Native Host 执行。不继续使用 Playwright
CDP，也不为每条工作流、每家店或每次 occurrence 新建 Chrome 实例。

库存、清退商品与体验分的 Trigger 必须固定到同一个 `browserInstanceId`，并共享账号级并发键：

```text
doudian-account:company-main
```

这个键表示“同一时刻只允许一个正式抖店浏览器工作流操控公司主账号上下文”，而不是
“同一个 Chrome 端口才互斥”。工作流在一个已绑定标签页中事务性导航，结束时恢复源 URL
与源店铺；由 BPA 打开的临时标签页必须在 Node 结束前关闭。

现有体验分 9222 Profile 只作为切换前的登录态参照，不复制 Cookie 或 Profile。切换时由
运营在统一 BPA Profile 中人工登录一次；真实 E2E 通过后删除旧 9222 启动入口。

### 4.3 多工作流资源预算

Mac 正式运行采用以下硬边界：

- 常驻 Chrome 实例：抖店账号最多 1 个；不按 Workflow 常驻实例。
- 活动浏览器 Workflow：同一账号最多 1 条；冲突 occurrence 直接 `skipped`，不排队堆积进程。
- 受管活动标签页：默认 1 个；跨域确需临时页时最多 2 个，Node 完成后立即清理。
- 体验分采集：复用同一标签页逐店切换，不为指标或店铺调用 `tabs.create`。
- 登录态：只存在于统一 BPA Profile；Core、Workflow、Dataset 和日志均不持有 Cookie。
- 空闲策略：Chrome 长期存活以保留登录态，工作流结束后仅保留受管起始页，不保留业务详情页。
- 观测：按 Chrome Profile 进程树统计 RSS/CPU，而不是把多个 Renderer 误报成多个 Chrome 实例。

这套边界优先解决当前“每做一条工作流就启动一组 Chrome”的内存放大问题。若 24 小时与
7 天资源窗口证明单实例 Renderer 仍持续增长，再根据 Profile 证据治理页面或评估更底层实现；
不得先用 Rust 替代主要受网页延迟约束的采集路径。

### 4.2 数据与投递决定

- BPA 数据库与不可变 Dataset 版本是生产主事实。
- 每店完成后立即写入，写入受 Run fencing token 约束。
- 飞书多维表是业务协作副本，不参与下一轮采集判断。
- 飞书消息是 Delivery，不改变已持久化采集事实。
- 外部投递结果不确定时进入 `uncertain` 和人工处理队列，不自动重试。

## 5. 资产与模块边界

| 层 | 计划资产 | 职责 |
| --- | --- | --- |
| Adapter | `doudian-experience` | 抖店体验分页、店铺切换、字段归一化、页面错误语义 |
| Browser Nodes | `doudian.experience.*` | 发现店铺、校验上下文、读取单店快照 |
| Service Nodes | `experience.*` | 持久化、聚合、构建结果 Dataset |
| Effect Node | `feishu.experience.daily.deliver` | 多维表幂等更新和日报消息投递 |
| Workflow | `doudian.experience-score.daily` | 顺序、foreach、部分成功和恢复点 |
| Trigger | `doudian-experience-daily` | 固定时间、版本、幂等周期和并发键 |
| Console | 通用 Run/Dataset/Evidence/Alert | 展示，不推断隐藏业务状态 |
| Operations | 安装、验收、删除旧路径 | 单一调度、Profile、日志和回退窗口管理 |

如果实施过程中必须为这一条业务修改 Engine、Compiler、Persistence 核心或控制台通用
协议，应停止本计划并单独提出通用产品能力，不得把业务特例塞进 Core。

## 6. Node 设计

### 6.1 `doudian.experience.shops.discover@1.0.0`

目的：从体验分页面可访问的店铺上下文中发现本轮候选店铺，不只依赖静态配置。

输入：

```yaml
expectedShops:
  - id: string
    name: string
excludedShopIds: [string]
```

输出：

```yaml
status: complete | partial
observedAt: date-time
currentShop: { id: string, name: string }
shops:
  - { id: string, name: string, collectable: boolean, reason: string }
discoveredCount: integer
collectableCount: integer
diagnostics: [string]
```

关键门禁：

- 自动发现数量和静态期望数量必须同时进入 Run 证据。
- 同名但不同 ID 不得静默合并。
- 无法证明店铺身份时返回 `SHOP_IDENTITY_UNCERTAIN`。
- 登录、验证码和风控返回阻断类 RiskSignal。

### 6.2 `doudian.experience.shop-context.verify@1.0.0`

目的：在读取前证明当前页面店铺 ID 和名称与 foreach 目标一致。

输出只允许：

- `matched`：ID 与名称均已证明；
- `mismatched`：明确是其他店铺；
- `uncertain`：页面缺少足够身份信息。

`mismatched` 和 `uncertain` 都不能继续读取并写入目标店铺事实。

### 6.3 `doudian.experience.snapshot.read@1.0.0`

目的：读取一个店铺的完整体验分快照。

输入：

```yaml
shop: { id: string, name: string }
businessDate: YYYY-MM-DD
```

输出：

```yaml
status: complete | no_score
observedAt: date-time
sourceUpdatedAt: date-time | null
shop: { id: string, name: string }
summary:
  totalScore: number | null
  level: string | null
  industry: string | null
  orders30d: integer | null
dimensions:
  - key: goods | logistics | service
    score: number | null
    metrics:
      - key: string
        label: string
        value: number | string | null
        unit: string | null
        score: number | null
        weight: number | null
        numerator: number | null
        denominator: number | null
        change: number | string | null
        note: string | null
evidence:
  pageUrl: string
  capturedAt: date-time
  screenshotRef: string
  structuredSnapshotRef: string
diagnostics: [string]
formMutations: 0
```

约束：

- 页面文本按不可信数据处理，不能成为执行指令。
- 数值必须保留原始字符串与规范化值，解析失败不能写成 0。
- 页面明确显示因订单不足暂无体验分时使用 `no_score`，不得判为采集失败。
- 详情页缺少任一必需维度时返回明确完整性诊断，不伪造 `complete`。
- 节点只读；除打开页面、切换店铺和展开详情外，不提交业务表单。

### 6.4 `experience.snapshot.persist@1.0.0`

目的：在单店读取成功后立即持久化，避免后续店铺失败丢失已完成结果。

幂等键：

```text
workflowRunId + shopId + businessDate + snapshotVersion
```

写入必须绑定 Workflow Run fencing token。旧所有者、错误店铺、重复但内容不一致的写入
全部拒绝，不做最后写入覆盖。

### 6.5 `experience.daily.aggregate@1.0.0`

目的：聚合本轮发现、尝试、持久化、失败、跳过和阻断数量，形成可展示 Dataset 与报告模型。

输出至少包含：

- discovered / collectable / attempted / persisted / failed / skipped；
- `completeShopIds` 与带原因的非完整店铺；
- 总分、维度分和重点指标的当日变化；
- 数据新鲜度和页面更新时间；
- 证据引用；
- 推荐的 Workflow 终态；
- 供 Operator Console 使用的通用 Dataset 描述。

### 6.6 `feishu.experience.daily.deliver@1.0.0`

目的：把已经持久化并聚合的事实投递到现有飞书多维表和日报消息。

权限：

- `network.feishu.bitable.write`
- `network.feishu.message.send`

幂等键：

```text
bitable row : platform + businessDate + shopId
message     : workflowRunId + reportTemplateVersion
```

外部请求超时且无法证明效果时返回 `uncertain`。不得自动重发消息或盲目覆盖多维表记录。

## 7. 数据模型

### 7.1 `experience.shop_snapshot`

| 字段 | 说明 |
| --- | --- |
| `snapshot_id` | 内容寻址或受审计生成的快照 ID |
| `workflow_run_id` | BPA Workflow Run |
| `fencing_token` | 写入所有权证明 |
| `business_date` | 业务日期 |
| `collected_at` | 实际采集时间 |
| `source_updated_at` | 页面展示的数据更新时间，可为空 |
| `shop_id` / `shop_name` | 经上下文校验的店铺身份 |
| `total_score` / `level` | 总体验分与等级 |
| `industry` / `orders_30d` | 页面摘要字段 |
| `status` | `complete` 或 `no_score` |
| `evidence_bundle_id` | 截图与结构化证据引用 |
| `adapter_version` | 解析版本 |
| `snapshot_digest` | 规范化内容摘要 |

唯一约束：

```text
(workflow_run_id, shop_id, business_date)
```

### 7.2 `experience.metric_observation`

| 字段 | 说明 |
| --- | --- |
| `snapshot_id` | 所属店铺快照 |
| `dimension_key` | 商品、物流、服务 |
| `metric_key` | 稳定、版本化的规范键 |
| `metric_label` | 页面展示名称 |
| `raw_value` | 脱敏后的原始值 |
| `normalized_value` | 解析后的数值，可为空 |
| `unit` | `%`、秒、小时、分等 |
| `score` / `weight` | 指标得分与权重 |
| `numerator` / `denominator` | 可验证的分子分母，可为空 |
| `change_value` | 页面变化值，可为空 |
| `note` | 业务说明，不含凭证 |

### 7.3 运行与 Dataset

- Run 元数据复用 BPA Workflow Run、Step Run、Trigger Run 和 Evidence Bundle。
- 每次成功或部分成功的日运行发布一个不可变 Dataset 版本：

```text
dataset id      : doudian-experience-daily
dataset version : <businessDate>.<workflowRunId-short>
record key      : <shopId>
```

- Dataset 只包含已持久化事实；失败、跳过和阻断信息保留在 Run 与聚合记录中。
- 不从旧 Excel、旧 SQLite 或飞书读取回退事实。

## 8. Workflow 设计

计划 Workflow：

```yaml
apiVersion: bpa/v1alpha3
kind: Workflow
metadata:
  id: doudian.experience-score.daily
  version: 1.0.1
spec:
  riskLevel: R1
  limits:
    maxDepth: 4
    maxStepExecutions: 500
  resourceSlots:
    doudian_account_browser:
      kind: browser
      allowedOrigins:
        - https://fxg.jinritemai.com
      authentication: authenticated
  root:
    kind: sequence
    steps:
      - discover_shops
      - collect_each_shop
      - aggregate_daily_result
      - publish_dataset
      - deliver_feishu
      - terminal
```

### 8.1 foreach 策略

- `maxItems`: 100，防止页面异常造成无界列表。
- `onItemError`: `collect`，普通失败继续形成部分结果；阻断类 RiskSignal 立即停止剩余浏览器步骤。
- 单店最长 4 分钟；整轮浏览器阶段最长 75 分钟。
- 单店成功后立即持久化，再进入下一店。
- 每次切换后重新校验店铺身份，不相信上一步页面状态。
- 取消或失去 Browser Control Lease 后不得继续读取或写入。

### 8.2 终态规则

| 条件 | Workflow 终态 |
| --- | --- |
| 全部可采集店铺已持久化，投递已确认 | `succeeded` |
| 至少一家已持久化，但存在普通店铺失败 | `partial` |
| 登录、验证码、风控或全局权限阻断 | `blocked` / `rejected` |
| 事实已持久化，但飞书效果无法证明 | `uncertain` |
| 已有有效同类 Run 或账号级浏览器租约 | `skipped` |
| 没有任何可用事实且非安全阻断 | `failed` |

`partial` 必须保留 discovered、attempted、persisted、failed 和 skipped 数量，不能报告为
“无数据”。

## 9. Trigger 与并发计划

### 9.1 TriggerSpec

```yaml
id: doudian-experience-daily
kind: schedule
workflow: doudian.experience-score.daily@1.0.1
timezone: Asia/Shanghai
schedule: daily 13:00
idempotencyPolicy: occurrence
missedRunPolicy: run_once
concurrencyKey: doudian-account:company-main
enabled: false
```

Trigger 在发布和真实 E2E 通过前保持禁用。

### 9.2 与库存的调度关系

库存当前约每 30 分钟触发，体验分抖店阶段历史运行约 32 分钟。两者不能依靠错开几分钟
避免冲突，必须依赖共同的账号级 Browser Control Lease。

目标策略：

1. 体验分保留当前 13:00 业务时间，减少运营变化。
2. 体验分持有账号级浏览器租约时，库存计划不得叠加浏览器操作。
3. 被占用的库存 occurrence 按固定策略 `skipped`，不形成等待进程堆积。
4. 下一次库存周期自然恢复，不由 Recovery Trigger 额外补一轮。
5. 切换前验证最长 90 分钟库存间隔仍满足已批准的新鲜度 SLO；不满足则重新选择窗口。
6. 飞书投递不持有浏览器租约，释放浏览器后再执行外部 Effect。

## 10. Operator Console 交付

首版不开发体验分专属控制台页面，复用通用产品能力：

### Trigger 视图

- 启用状态；
- 固定 Workflow 版本；
- 每日计划和时区；
- 上一次与下一次 occurrence；
- 因并发被跳过的原因。

### Run 视图

- discovered / attempted / persisted / failed / skipped；
- 每店 Step 状态与中文诊断；
- Browser Control Lease 和 fencing 所有权；
- 最终状态与外部投递状态。

### Dataset 视图

- 最新业务日期和页面更新时间；
- 每店总分、等级和三维分数；
- 重点指标值与变化；
- 数据版本和内容摘要。

### Evidence 视图

- 单店结构化页面快照；
- 截图证据；
- Adapter、Node、Workflow 版本；
- 采集时间、页面来源和店铺身份校验证据。

### Alert 视图

- `SESSION_EXPIRED`、`CAPTCHA_REQUIRED`、`RISK_CONTROL`；
- 发现店铺数异常变化；
- 店铺身份不匹配；
- 覆盖不足或字段完整性下降；
- Feishu Effect `uncertain`；
- 证据或磁盘容量超过阈值。

如果通用 Console 不能表达这些字段，优先增加通用 Run/Dataset/Evidence 展示能力，并作为
独立产品变更评审；不得向 `apps/inventory-monitor` 增加体验分特例。

## 11. 安全与隐私

1. Chrome Profile、Cookie、Local Storage 和登录凭证不进入仓库、报告或聊天。
2. Feishu 凭证使用服务器侧 0600 配置，Node 只接收受限资源句柄。
3. Extension 仅允许 `https://fxg.jinritemai.com`，不扩大通配域名。
4. 页面内容只能进入业务字段和证据，不能修改 Workflow、Trigger 或权限。
5. 验证码、设备校验、登录过期和风控立即停止浏览器阶段并告警。
6. 截图可能包含店铺 ID、员工或客服信息，按内部受限证据处理。
7. 外部投递效果不确定时不自动重试。
8. 发布包不包含源码、测试、`.bak_*`、虚拟环境、Profile、source map 或长期凭证。
9. 任何人工重新认证都通过明确的远程恢复入口完成，不通过复制 Profile 绕过认证。

## 12. 证据与保留策略

建议策略，实施前由运营确认：

| 资产 | 保留期 | 规则 |
| --- | --- | --- |
| 规范化体验分事实 | 13 个月在线 | 支持同比、月度复盘 |
| Workflow/Trigger 审计 | 按 BPA 审计策略 | 不随业务日志清理 |
| 普通成功截图 | 30 天 | 过期后保留摘要和结构化事实 |
| 失败/阻断截图 | 90 天 | 关联开放事件时不得提前删除 |
| 运行文本日志 | 30 天 | 禁止记录 Secret 和 Cookie |
| 旧项目历史目录 | 一次性只读归档 | 不再作为生产输入 |

清理必须使用明确目录、白名单资产类型和可审计任务；不得递归清理 Profile、数据库或整个
项目根目录。

## 13. 实施阶段与交付 PR

### P0：审计与契约冻结

状态：已完成。

交付：

- 当前拓扑、字段、调度、输出和风险清单；
- 抖店 13 店最近成功 Run 的脱敏 fixture；
- 至少一个部分成功、一个登录阻断和一个店铺不可采集 fixture；
- 字段规范化表和 Error Code 表。

门禁：fixture 不包含 Cookie、Token、员工敏感信息或未授权截图。

### P1：Adapter、Node 与 Workflow 候选

状态：本机候选与 Provider E2E 已完成（2026-08-09），未部署。

已交付候选：

- 新建 `doudian-experience` Adapter；
- 新建发现、事务性身份校验与快照读取 Node；
- 新建聚合 Node；逐店 Step 输出已形成 Runtime 检查点；
- 新建 `doudian.experience-score.daily@1.0.1` Workflow；普通单店失败进入
  foreach `collect` 后聚合，阻断类 `rejected` 仍立即终止；
- fixture 行为测试、Schema 测试、RiskSignal 测试；
- 正式资产本机 E2E 通过临时 Trigger、同一 Browser Session、资源绑定、IR2 Provider、
  终态和浏览器租约释放，并与清退商品、库存依次运行时保持单实例记录；
- 候选资产保持未部署，未创建或启用生产 Trigger。

留待 P2/P3：正式 `experience.snapshot.persist` 服务写入、不可变 Dataset 发布、截图 Evidence
与飞书 Effect。当前候选不能以本地测试替代这些生产能力。

门禁：

- `pnpm verify` 全绿；
- 不调用旧 `.command` 或 Python Collector；
- 不修改 Engine/Compiler/Persistence 通用协议；
- 全部阻断信号 fail closed。

### P2：浏览器真实页面 E2E

建议 PR 2：

- 在受控体验分 Profile 中安装已构建 Extension；
- 通过 Native Host 绑定专用浏览器资源；
- 校验自动发现、切换、摘要、三维明细和截图；
- 验证 13 店完整扫描；
- 验证页面改版、无体验分、停业店铺、登录过期和验证码分支。

门禁：

- 真实页面 13/13 完整 Run；
- 发现数量、读取数量、持久化数量一致；
- 每店证据可回读；
- 页面身份不确定时没有错误店铺写入；
- 不与库存浏览器操作重叠。

### P3：Trigger、Console 与 Delivery

建议 PR 3：

- 发布 Workflow 1.0.1 与 Node/Adapter 1.0.0；
- 创建但不启用 Schedule Trigger；
- Operator Console 展示 Run、Dataset、Evidence、Alert；
- Feishu Bitable 与消息 Effect 完成幂等和不确定效果测试；
- 增加容量与数据新鲜度告警。

门禁：

- Trigger 固定不可变 Workflow 版本；
- 同一 occurrence 最多一个有效 Run；
- Console 不依赖旧文件推断状态；
- 飞书重复请求不产生重复日报；
- 不确定 Effect 不自动重试。

### P4：生产切换

建议 PR 4 / 运维变更：

1. 只读确认库存、体验分、浏览器控制租约均无活动实例。
2. 确认体验分专用 Profile 登录有效，Extension 与 Native Host 握手正常。
3. 将旧三平台 launchd 入口改为只运行微信和快手。
4. 启用 BPA 抖店体验分 Trigger。
5. 只允许一个受控首轮 occurrence。
6. 回读 Workflow Run、13 店结果、Dataset、Evidence 和 Feishu Effect。
7. 观察下一轮库存自然恢复，确认没有新控制面冲突。

切换当天不得同时执行旧抖店 Collector 和新 BPA Workflow。

### P5：连续窗口与旧路径删除

建议 PR 5 / 运维收口：

- 连续 7 个自然日观察固定 Trigger；
- 验证至少一次安全阻断或受控故障演练；
- 删除旧抖店 launchd 调用、旧 Python 抖店 Collector 和旧 9222 CDP 启动入口；
- 删除运行环境中的抖店 `.bak_*` 和失效配置，但保留明确的只读历史归档；
- 记录最终 Runtime Closure、版本、安装、回退窗口结束和容量基线；
- 微信和快手迁移另立计划，不与本计划暗中绑定。

## 14. 生产切换前置检查

以下任一项不满足，禁止启用新 Trigger：

- [ ] `main` 上的候选已通过 required checks 并按人工发布边界发布。
- [ ] 公司 Mac mini Runtime Closure 与发布清单一致。
- [ ] Operator Console、Core、Native Host、Extension 健康。
- [ ] 体验分专用 Profile 登录有效且无需验证码。
- [ ] 没有运行中的库存或体验分进程。
- [ ] 没有有效 Browser Control Lease 或遗留 running schedule。
- [ ] 旧 launchd 已规划为微信/快手专用，不再触发抖店。
- [ ] 新 Trigger 仍为 disabled，直到切换动作的最后一步。
- [ ] Feishu Effect 的配置存在但未被打印或复制。
- [ ] 13 店期望清单、自动发现规则和排除清单已经人工确认。
- [ ] 库存新鲜度允许一次受控的 60–90 分钟浏览器窗口。
- [ ] 回退动作、责任人和观察截止时间已记录。

## 15. 验收矩阵

| 层级 | 验收条件 |
| --- | --- |
| Contract | Node/Workflow/Adapter Schema 通过；字段和错误码版本化 |
| Fixture | 成功、部分成功、无分、停业、身份不匹配、登录、验证码、风控均覆盖 |
| Local E2E | Engine + 浏览器 Adapter fixture + Workflow 编译通过；Persistence、截图 Evidence 与 Effect 留待 P2/P3 |
| Browser E2E | 登录态真实页面 13/13；每店身份、摘要、明细、截图可证明 |
| Concurrency | 库存与体验分不会同时取得账号级浏览器所有权 |
| Persistence | 单店立即持久化；失去 fencing 后写入被拒绝 |
| Terminal state | 部分成功、阻断、不确定投递不会被压成成功或失败 |
| Delivery | Bitable 幂等；日报不重复；不确定效果转人工 |
| Console | 定时、Run、Dataset、Evidence、Alert 可由非技术同事查看 |
| Production day 1 | 首轮完整，库存下一自然周期恢复，无第二控制面 |
| Production window | 连续 7 天自动运行，无人工日常触发，无未分类失败 |
| Cleanup | 旧抖店调度和运行代码删除，历史仅只读归档 |

最终验收不是“脚本返回 0”，而是：

```text
固定 Trigger
+ 唯一浏览器所有权
+ 13 店范围证明
+ 每店持久化
+ 可回读证据
+ 正确终态
+ 外部投递确认
+ 控制台可见
+ 连续 7 天生产窗口
```

## 16. 回退边界

回退只用于生产切换窗口，不成为长期兼容层。

### 允许回退的条件

- 新工作流在首轮没有产生任何可用事实；
- 新 Profile 无法完成登录恢复；
- 店铺身份或字段完整性无法证明；
- 新 Trigger/租约导致库存无法自然恢复；
- Feishu Effect 产生无法人工确认的外部状态。

### 回退动作

1. 禁用新 Trigger。
2. 等待 Workflow Run 和 Browser Control Lease 进入终态，不强杀持有有效租约的进程。
3. 保留已写入事实和 Evidence，不删除、不覆盖。
4. 只读判断飞书效果是否已经发生；不自动重发。
5. 在确认没有活动实例后，临时恢复旧抖店入口的下一次自然周期。
6. 修复候选并重新经过发布与切换门禁。

连续 7 天验收完成后，旧抖店入口和临时回退资产必须删除。

## 17. 风险登记

| 风险 | 当前级别 | 控制措施 |
| --- | --- | --- |
| 库存与体验分并行操作抖店 | 高 | 账号级并发键、唯一 Browser Control Lease、跳过而非堆积 |
| BPA 统一 Profile 当前登录阻断 | 高 | 在统一 BPA Profile 人工恢复登录；所有抖店工作流共享同一实例并逐条验收 |
| 店铺自动发现数量变化 | 高 | discovered/expected 双重证据；新增或消失店铺告警 |
| 页面改版导致字段缺失 | 高 | 结构化完整性门禁、Evidence、明确 Error Code |
| Feishu 写入效果不确定 | 高 | 幂等键、效果确认、`uncertain` 不自动重试 |
| 旧项目没有 Git 版本关系 | 中 | 从 BPA 仓库重建正式资产；签名发布闭包 |
| 5.8GB 运行资产继续增长 | 中 | 白名单保留策略、容量告警、验收后删除旧运行路径 |
| 12 家配置与 13 家发现不一致 | 中 | 静态期望不是唯一真相；按 ID 发现并要求人工确认变化 |
| 历史 Excel/飞书口径不一致 | 中 | 新事实从切换日开始；旧资产只读，不作为回退数据源 |
| 浏览器读取耗时超过库存窗口 | 中 | 75 分钟整轮上限、库存 SLO 前置门禁、超时后安全终态 |

## 18. 待确认事项

以下事项需要在 P0/P1 结束前由业务或运营确认：

1. 13:00 是否必须保持，还是可移动到低业务负载时段。
2. 13 家自动发现店铺是否全部属于正式监控范围。
3. 哪些体验分指标是控制台首屏重点项，哪些只保留在 Dataset 详情。
4. 飞书多维表是否继续作为协作副本，以及现有字段顺序是否属于业务契约。
5. 成功截图 30 天、失败截图 90 天、结构化事实 13 个月的保留期是否接受。
6. 单店 `no_score`、停业、授权不足分别需要怎样的运营提醒级别。
7. 体验分下降的业务阈值只展示变化，还是后续形成独立风险策略；本期不擅自定义阈值。
8. 微信和快手在抖店接管后是否继续共享原 13:00 入口，还是另立迁移计划拆分调度。

## 19. 完成定义

本计划只有同时满足以下条件才算完成：

- 抖店体验分由已发布 BPA Workflow 和固定 Trigger 独立运行；
- 13 店范围、单店身份、结构化结果和证据可证明；
- 库存与体验分不存在并行浏览器控制；
- 飞书外部投递独立、幂等且不确定效果可人工处理；
- 非技术同事可从 Operator Console 看计划、Run、结果、证据和告警；
- 连续 7 天无需 Codex 或开发者日常触发；
- 旧抖店 `.command`、Python Collector、CDP 启动入口和生产调度已删除；
- 微信和快手仍有明确、独立且未被误删的生产入口；
- 生产安装闭包不包含源码、开发资产、Profile 或长期凭证。

在这些条件满足前，只能称为“接管候选”或“受控切换中”，不能称为 BPA 已完成生产接管。
