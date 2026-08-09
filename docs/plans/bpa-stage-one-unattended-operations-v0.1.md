# BPA 阶段 1 无人值守实施索引 v0.1

> 文档类别：实施计划与完成证据索引。  
> 日期：2026-08-09。  
> 约束：本计划服从 `docs/normative/bpa-roadmap-v1.md`；当前只开发与本机验证，
> 不授权部署、重启生产、触发库存任务或修改生产数据库。

## 1. 目标与最小闭环

阶段 1 先完成一条可验收闭环：

```text
Workflow terminal fact
  -> durable Attention projection
  -> operator dashboard
  -> idempotent delivery outbox
  -> mobile notification
  -> authenticated recovery session
  -> operator completes login/challenge in the managed profile
  -> explicit new run
```

`rejected` 与 `uncertain` 都是终态。恢复登录不会改写旧 Run，也不会从旧 checkpoint
自动续跑；运营处理原因后显式创建新 Run。`uncertain` 在外部效果被人工确认前禁止重试。

## 2. 现有能力与缺口

| 层 | 已实现 | 仍缺 |
| --- | --- | --- |
| 风险识别 | Adapter、Browser Protocol 和 Runtime 能保真返回 `SESSION_EXPIRED`、`CAPTCHA_REQUIRED`、`RISK_CONTROL`；Run 能保持 `rejected` / `uncertain` | 无统一 Attention 投影时只能逐个翻 Run |
| 处理队列 | Assistance Task 有持久化、CAS、fencing、租约和控制台处理界面 | 终态失败不是 Assistance Task，不能直接当作可恢复 checkpoint |
| 控制台 | 本地 Console 能读 Doctor、浏览器观察、任务和运行详情 | 缺终态问题列表、确认状态和远程入口 |
| 外部通知 | 库存 App 有业务专用飞书报告与告警 | 缺平台级 Delivery Outbox、投递幂等和效果确认 |
| 登录态 | 公司 Mac 使用持久化 Chrome Profile | 缺失效主动通知和安全的远程人工恢复会话 |

## 3. 已完成的第一层

已合并的第一层增加平台级 `attention.list`：

1. SQLite 按终态和更新时间有界读取 Run，不扫描页面、Cookie 或浏览器存储。
2. `@bpa/attention-core` 只从受控字段提取风险码；原始错误消息不进入投影。
3. 登录、验证码与风控归为 `authentication` 阻断；`uncertain` 明确提示不得盲目重试。
4. Console Host 将投影映射为稳定 UI 合同，Operator Console 在首页展示问题数量、
   标题与下一步。

该层解决“面板能看见”，不等于“手机已收到推送”。

## 4. 第二层：持久 Attention 与 Delivery Outbox

Schema v16 与 v17 已进入主线，平台级投递状态机不把飞书逻辑塞进 Workflow：

- `attention_record`：稳定 ID、Run/Node 身份、分类、严重度、创建时间、确认状态和确认人。
- `attention_delivery`：Attention ID、Channel、幂等键、请求摘要、投递状态、效果确认和
  `uncertain` 原因。

`attention_record` 已实现 open/acknowledged、revision CAS、确认审计、重启恢复和 Operator
Console 的“已知晓”动作。Schema v17 要求问题终态必须在同一事务写入一条 pending
`attention_delivery`；缺少任一事实时终态整体回滚。Delivery 通过 revision CAS 领取，记录
attempt、短租约、明确成功、明确失败或 `uncertain`；投递中的租约过期直接落为
`DELIVERY_LEASE_EXPIRED`，不得自动重复发送。Operator Console 同时显示投递状态、次数和
受控诊断码。平台中立 Dispatcher 每次最多领取一条任务；Provider 明确拒绝才记 `failed`，
传输异常一律脱敏为 `DELIVERY_TRANSPORT_UNCERTAIN`。v16/v17 均不做历史失败回填，旧记录
没有可证明投递事实时显示 `missing`。

生成必须与 Run 终态转换位于同一 SQLite 事务。投递器只消费平台级 Delivery，不读取业务
表；成功、明确失败和效果不确定分别持久化。超时后如果不能证明消息未送达，状态必须为
`uncertain`，不得自动重复发送。当前候选只完成持久化状态机和对账可见性，尚未连接真实
通知 Channel；因此 `delivered` 只在未来 Provider 明确受理后才能写入，不能由本机测试伪造
成生产事实。

第一种 Channel 采用现有公司通知通道，但凭证只存在于目标 Mac 的 `0600` 配置中。
消息只含 Workflow、Run ID、严重度、发生时间和受控操作提示，不含 Cookie、页面正文、
数据库 URL 或原始错误堆栈。

候选实现采用独立 `@bpa/adapter-feishu-notification`，不复用库存日报的业务模板。Core 默认
不创建投递器；只有显式设置 `BPA_OPERATOR_NOTIFICATION_CONFIG` 后才读取绝对路径配置。
配置必须是当前用户持有、非符号链接、严格 `0600`、不超过 8 KiB 的普通文件，仅允许
`provider=feishu-webhook` 与 `webhookUrl` 两个字段。Webhook Origin 和路径受 allowlist 限制，
请求、日志、审计和面板均不回显 URL。4xx 或 Provider 非零码是明确失败；5xx、超时、网络
异常和畸形成功响应均为 `uncertain`。该开关在生产上线审批前保持未配置状态。

## 5. 第三层：远程登录恢复

远程恢复不是复制 Cookie，也不是绕过验证码。最小安全形态是：

1. 已认证用户从通知或统一控制台创建一次性 Recovery Session。
2. Session 钉死 `browserInstanceId + profileId + tabId + pageEpoch`，短时过期且一次使用。
3. Core 只授权登录所需 Origin；普通 Workflow 调度在该 Profile 上暂停取得新浏览器租约。
4. 用户远程操作同一受管 Chrome 标签页，人工完成登录、验证码或设备确认。
5. Page Observation 重新证明 `authenticated` 后关闭 Session，写审计记录并允许显式新 Run。

Recovery Session 不暴露 DevTools、文件系统、任意 URL 导航或凭证导出；风控仍然可以
拒绝恢复，且拒绝结果继续进入 Attention。

Schema v18 已进入主线并实现其中的持久安全内核：只允许 open、blocking、authentication
Attention 创建 Session；一次性令牌只返回一次，SQLite 仅保存 SHA-256 摘要；Session
精确绑定 Browser Session、`browserInstanceId`、当前托管 Profile、Tab、HTTPS Origin
和初始 `pageEpoch`，有效期限制为 1–15 分钟。创建 Session 与取得
`browser-instance:<id>` 控制租约位于同一事务，因此已有 Workflow 占用时不会创建恢复
会话，恢复期间新 Workflow 也无法取得同一浏览器实例。激活只接受原始 `pageEpoch`；
完成时必须由同一 Session/Instance/Profile/Tab/Origin 的新鲜 Page Observation 证明
`ready + authenticated`，然后释放租约并记录审计。令牌不能重复激活，过期、撤销、绑定
漂移均为终态；完成恢复不会改写旧 Run 或自动确认 Attention。

PR #18 已将其接入现有仅监听 `127.0.0.1` 的 Console Host：恢复开始、完成和撤销均要求
现有一次性启动令牌换取的 HttpOnly Session、同源检查与 CSRF；Console Backend 内部完成
令牌签发与激活，不把一次性令牌交给前端。浏览器断线会在同一持久事务将 issued/active
Session 置为 invalidated、释放原控制租约并写审计。该层仍不是手机远程入口，也不提供
页面画面或键鼠控制；远程层只允许固定的同标签页查看、输入、完成/撤销能力，任意导航、
DevTools、文件选择和剪贴板导出继续禁止。

## 6. 多工作流共用 Chrome 的性能形态

抖店工作流不再“一条流程启动一套 Chrome”。正式形态固定为：

- 每个业务平台和隔离要求对应一个长期存活的受管 Profile；现有抖店工作流优先共享一个
  Chrome 实例、Profile 和 `browserInstanceId`。
- 同一账号上下文的浏览器阶段通过账号级 concurrency key 串行；HTTP、文件、SQLite、
  聚合和外部 Delivery 在释放浏览器租约后并行。
- Workflow 复用少量受管标签页；结束后回到受管起始页并关闭业务详情页。不得无界新建
  Window、Profile 或后台标签页。
- 保活只使用低频、只读页面观察；不运行全量采集，不占用 Workflow 租约。频率必须依据
  24 小时 Chrome 曲线和平台限速证据调整。
- 只有业务身份或平台安全边界确实要求隔离时才新增 Profile；内存便利不是复制登录态的
  理由。

这样浏览器资源上限与“受管 Profile 数”相关，而不是与“同时存在的 Workflow 数”相关。

PR #19 已把这项边界下沉到 Trigger Runtime：凡 TriggerSpec 声明
`browserInstanceId`，Run 创建前必须取得 `browser-instance:<id>` 控制租约，并把独立
fencing token 持久化到 Schema v19 的 Trigger Run；运行期间与业务并发租约一起续租，
Workflow Run 创建与 Trigger Run 关联在一个事务中提交，终态再一起释放两把租约。
浏览器控制租约已被库存、另一条 Trigger 或 Recovery Session 持有时，
Schema v20 已随 PR #22 进入主线，把逻辑 Occurrence 与
execution Attempt 分表：租约忙只写持久 `deferred + nextAttemptAt`，不创建 Attempt、
不启动额外浏览器；释放后由同一 Mac Trigger Runtime 继续竞争。fixture 使用库存、清退商品、
体验分三个不同业务并发键和同一浏览器实例，证明任一时刻只有一个 Run 能进入浏览器阶段。
v1alpha2 候选还把积压限制为每 tick 最多 1000 个 occurrence，并在追平前禁止启动旧页
候选；Schema 19 仍有旧 TriggerSpec/Run 时 Schema 20 启动即失败，生产不能直接热升级。
后续正式资产 E2E 又以一个 Browser Session 和一个页面依次跑完三条 Workflow，证明 Trigger
终态后租约释放且实例记录不增长；它仍是 Provider fixture，真实页面、标签页上限和 Chrome
进程数仍需后续本机浏览器 E2E 验收。

Schema v21 已随 PR #23 进入主线，继续补齐计划层问题面：没有 Workflow Run 的
`blocked/failed/missed/skipped` 与 dashboard-only Attention 原子提交，已有 Workflow Run
的终态只保留 Run Attention，避免重复通知；旧版 Workflow 的 Trigger 调用在任何 Run 写入
前拒绝，不能留下孤儿 Run。库存指挥台按 `appId=inventory-monitor` 只读这些 Attention，
不写库存数据库、不确认、不恢复、不投递，也不弹浏览器桌面通知。Core 或响应契约不可读时
面板 fail-closed，明确显示“BPA 触发状态暂不可读”。Schema 20 Attention 控制面非空时
Schema 21 拒绝升级并保持原库，部署前必须走导出、退役和空库门禁。

PR #24 进一步固定 Browser 交付闭包：浏览器命令、资源绑定和 dispatch 都要求精确的
Node 与 Adapter id/version/digest，并校验 Extension 最低版本；手动 `run.create` 与
`run.node.create` 不得绕过 Trigger 直接启动 browser-bound Run。失去 Browser Control
Lease 的 Trigger 必须先持久取消已关联 Run，再收口 Attempt；取消路由从冻结的 Run
Resource Binding Snapshot 恢复，不依赖已经清空的活动 checkpoint。该层已通过 fixture、
协议与对抗测试，但尚未部署。

### 6.1 进程所有权与并行边界

以下是“常驻 Core + 单共享 Chrome”的灰度候选，不是已经越过阶段 0 的 normative 长期决定。
它先排除“每条 Workflow 一个常驻进程”，候选进程形态为：

| 组件 | 生命周期 | 数量上限 | 所有权 |
| --- | --- | --- | --- |
| Local Core | launchd 常驻 | 1 | 唯一 Trigger、Run、Lease、Browser Gateway 与事实控制面 |
| Inventory Monitor | launchd 常驻 | 1 | 库存领域 API 与指挥台；不拥有浏览器调度 |
| 受管 Chrome | launchd 常驻 | 每个安全隔离域 1；当前抖店为 1 | 一个 Profile、一个 `browserInstanceId`、一个 Extension 闭包 |
| Team Worker | Core 首次需要时懒启动并复用 | 首次调用前 0；warm idle 与 active 合计最多 1 | Core 子进程；不得按 Node 重复 spawn；当前没有 idle TTL |
| Native Host | Extension 连接期 | 每个受管 Extension 连接 1 | 只承载协议，不拥有 Workflow 生命周期 |
| Console Host | 操作员会话期 | 0 或 1 | 本地/远程控制面，不执行浏览器业务 |

浏览器按需还是常驻，仍须用同一 Profile 的 24 小时资源曲线、重连次数和登录稳定性做对比后
决定；在该证据闭合前，只能说当前公司形态和本次灰度候选使用 launchd 常驻 Chrome。

Chrome Extension service worker 可能被浏览器回收并重建；长期保证的是可恢复的
Session/Resume/Observation 协议，不把“JavaScript 背景页永远常驻”当成产品前提。

当前 Trigger Runtime 对 browser-bound Workflow 在整个 Run 生命周期持有
`browser-instance:<id>` 租约，而不是在最后一个 Browser Node 后提前释放。阶段 1 先保留
这个保守边界：同一抖店 Profile 的 browser-bound Run 全程串行。纯 HTTP、SQLite、文件、
计算和 Delivery Workflow 的有界 provider lane 是目标边界，当前 `drainOnce` 仍按全局顺序
逐个等待 outbox，不得把“没有 Browser Lease”误报成已经并行。只有在 24 小时和 7 天证据
证明队列等待成为真实 SLO 瓶颈后，才单独评审 provider lane 或 phase-level resource lease；
不得在本轮用隐式提前释放换吞吐。

### 6.2 资源预算与灰度停止线

以下是公司 Mac 灰度的候选停止线，不是已经通过的生产 SLO。基线取灰度前同一版本、同一
Profile 连续 30 分钟 idle 样本；所有 RSS 都按完整 Chrome Profile 进程树统计：

| 指标 | 通过条件 | 立即停止灰度 |
| --- | --- | --- |
| Chrome 实例/Profile/Session | 始终 1/1/1；断线恢复替换旧 Session，不叠加 | 出现第二个受管抖店实例或两个 ready Session |
| 受管标签页 | 观测目标为稳态 1、跨域临时页最多 2；硬拒绝门尚待实现 | 连续 3 个样本超过 2，或业务详情页无界增长 |
| Chrome 进程树 | p95 不超过 idle 基线进程数 +2 | 峰值超过基线 +4 且 15 分钟不回落 |
| Chrome RSS | 24h p95 不超过参考窗口 + max(128 MiB, 15%)；结束后 15 分钟中位数回到运行前 + max(64 MiB, 10%) | 连续 3 个 60 秒样本超过 2 GiB |
| Core / Inventory RSS | 各自 24h p95 不超过参考窗口 + max(16 MiB, 10%) | Core 连续 3 个样本超过 384 MiB，或任一服务命中稳定性增长门禁 |
| BPA 总进程树 RSS | 24h p95 不超过参考窗口 + max(192 MiB, 15%) | 无同机参考窗口，或业务结束后 15 分钟仍持续增长 |
| Team Worker | 首次调用前为 0；启动后 warm idle/active 合计最多 1 | 同时出现 2 个，或 Core 停止后仍残留 |
| Browser Control | 同一 `browserInstanceId` 最多 1 个有效 owner | 重叠 owner、fencing 漂移或手动 Run 绕过 Trigger |

现有单点证据约为 Core 195 MiB、库存服务 32 MiB、Chrome Profile 11 个进程/1.23 GiB；
它只用于设置灰度保护线，不证明稳定。正式结论仍必须由 60 秒采样、完整 page cache、24 小时
窗口和 7 天稳定性门禁给出。Chrome 启动参数中的远程调试与三个反后台节流开关属于历史
库存入口；在证明没有旧 CDP 消费者前不得直接删除，证明后应作为独立 canary 逐项退出。

灰度顺序固定为：只观察基线 → 新闭包但 Trigger 全禁用 → 精确 Extension build、单 Profile
进程树、单 ready Session 与空租约 preflight → 体验分单 Workflow → 清退商品 → 库存。
任一阶段只允许一个控制面。业务回退默认在同一新闭包内禁用新 Trigger、恢复已验证的旧业务
入口；二进制回退只允许目标 Runtime 与当前 Schema 兼容且新闭包尚无业务写。不得把前向
Schema 降级描述成可恢复旧二进制，也不得复制登录态。

### 6.3 进入公司 Mac 灰度前的工程硬缺口

1. **安装维护门**：installer 在停止 Core 前必须证明没有 active Run、Trigger Attempt、
   Browser/Recovery Lease 或正在写入的业务任务；只取得 maintenance lock 不等于业务已 drain。
2. **Chrome source-to-closure**：当前 `com.bpa.inventory-chrome.plist` 仍是库存仓库资产，
   不在 Runtime Closure/installer 所有权内，且包含硬编码 Profile、Extension 路径、CDP 与
   反后台节流参数。正式唯一控制面必须把受管 Chrome launch agent 配置、精确 Extension
   路径、Profile 身份和回读校验纳入签名闭包。
3. **标签页硬上限**：Extension 目前只在命令结束或启动恢复时回收归属子标签页；必须在
   创建临时页前拒绝超过上限，并把当前归属页数量写入脱敏运行指标。
4. **有界内存结构**：Extension 的 pacing/cancel/probe generation 集合与 Core 的 page
   probe 请求表必须有 TTL、容量上限和 size 指标；24 小时窗口前先通过增长反例。
   本代码候选已关闭 Core 子项：page probe 表为 32 项、10 秒 TTL，完成、断线和超时均
   回收，迟到响应不能清除同页新请求，容量满时 fail-closed。Extension pacing/cancel/probe
   generation 的 TTL、容量和指标仍未完成。
5. **单连接重连**：Extension 到 Native Host 的 connect 需要 generation/in-flight guard、
   有上限退避和旧 Port 回调隔离；覆盖 onDisconnect 与连接异常同时发生的对抗测试。
6. **并行 lane 决策**：第一版不实现 provider 并行。若后续引入，必须按 provider/资源声明
   有界并发，SQLite 写、同 Dataset/Run 终态与同外部 Effect 仍串行，不开通自由 Promise 并发。
7. **进程退出所有权**：Core 必须跟踪并关闭 Control Socket 的现有长连接；Node Runtime
   Registry 必须 dispose Team Worker。否则 launchd 更新可能等待 Native Host，或遗留 worker。
   本代码候选已实现这两项并覆盖反向 dispose、重复关闭、多个失败聚合和 resident socket
   关闭反例；尚未部署，不能替代公司 Mac 的孤儿进程检查。
8. **采样可见性**：现有采集器还不统计 Native Host、Team Worker、短命 Node 子进程、
   V8 heap、event-loop lag、标签页、Gateway 队列和常驻 Map size。常驻灰度前必须补这些角色
   指标和 Run terminal 后 15 分钟 quiescence marker。
   本代码候选已把 Core V8 process memory、Browser Gateway 连接/ready Session、pending
   cancel 和 page probe size/capacity/TTL 纳入原子白名单快照、采集器与分析结果；其余角色、
   event-loop lag、标签页、Gateway 队列和 quiescence 仍未完成。
9. **入口清退**：旧 source/tsx launchd、Inventory Scheduler 模式与签名闭包 Core 不能并存。
   灰度前选定签名闭包为唯一 Core；legacy recovery 仍会按步骤启动短命 Node 子进程，只有
   正式库存 Workflow 接管后，per-step Node spawn 才能归零。

候选 Profile 状态机固定为：

```text
DISABLED → STARTING → BRIDGE_PENDING → IDLE_AUTHENTICATED
                                      ├→ TRIGGER_LEASED → RUNNING → POST_BROWSER_DRAIN → IDLE_AUTHENTICATED
                                      ├→ RECOVERY_LEASED → HUMAN_RECOVERY → IDLE_AUTHENTICATED
                                      └→ AUTH_REQUIRED
          ↘ DISCONNECTED → QUARANTINED → MAINTENANCE
```

Schedule 与 Manual 都必须先形成持久 Trigger Occurrence；Recovery 与 Workflow 互斥；断线时
不启动第二个 Chrome，恢复后必须取得新鲜 Observation。旧 launchd、CDP、WorkBuddy 与人工
点击不服从 BPA Lease，灰度前必须清退，或在唯一变更窗口内明确停用。

## 7. 实施顺序与门禁

1. **面板投影**：终态反例、登录风险码、脱敏和 UI 测试通过。
2. **持久 Attention**：终态事务原子性、重复事件幂等、确认 CAS 和重启恢复测试通过。
3. **外部投递**：成功、明确失败、超时不确定和重复消费测试通过；`rejected` / `uncertain`
   生成率与投递率可对账为 100%。
4. **共享浏览器预算**：一个受管抖店 Profile 并发运行三条 Workflow 的 fixture/E2E，
   Chrome 实例数不增长，标签页有界，账号级租约不重叠。
5. **Recovery Session**：短时令牌、Origin/Tab 绑定、断线关闭、审计和登录恢复反例通过。
6. **生产验收**：另行授权后在公司 Mac 灰度；不得与库存活动周期重叠，不以本机测试替代。

## 8. 明确不做

- 不把 `rejected` 改回可恢复中间态。
- 不自动处理验证码、设备校验或平台风控。
- 不复制、导出或集中保存 Cookie 和 Local Storage。
- 不由各业务 App 各自解释 Run 终态或各写一套通知重试逻辑。
- 不因并行 Workflow 启动多个相同抖店 Profile。
- 不把“通知请求已发送”冒充“运营已收到并处理”。
