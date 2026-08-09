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

当前本机候选把这项边界下沉到 Trigger Runtime：凡 TriggerSpec 声明
`browserInstanceId`，Run 创建前必须取得 `browser-instance:<id>` 控制租约，并把独立
fencing token 持久化到 Schema v19 的 Trigger Run；运行期间与业务并发租约一起续租，
Workflow Run 创建与 Trigger Run 关联在一个事务中提交，终态再一起释放两把租约。
浏览器控制租约已被库存、另一条 Trigger 或 Recovery Session 持有时，
当前 occurrence 直接 `skipped`，不等待、不启动额外浏览器。fixture 使用库存、清退商品、
体验分三个不同业务并发键和同一浏览器实例，证明任一时刻只有一个 Run 能进入浏览器阶段；
真实页面、标签页上限和 Chrome 进程数仍需后续本机 E2E 验收。

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
