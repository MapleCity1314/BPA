# BPA 长期产品执行状态 v1

> 文档类别：当前执行状态与阶段证据索引。
> 初始记录时间：2026-08-06；最近更新：2026-08-09。
> 权威等级：current-state。本文件记录"现在做到哪里"，产品边界和阶段顺序分别以
> `docs/normative/bpa-product-form-v1.md` 与 `docs/normative/bpa-roadmap-v1.md` 为准。

## 1. 当前判定

- 当前阶段：**阶段 0，稳住上阵**。
- Git 基线：截至 2026-08-09，PR #2–#26 均已在 required checks 通过后进入 `main`；
  最新基线为 PR #26 merge commit `8999fbfa49de45292274a59f6ebe2319c01bbeda`。阶段 0 结构收敛、资源观测、单浏览器常驻候选、
  爆款图片来源闭包校验、体验分事实链和清退商品 Mac Runtime 候选均已进入主线。
- GitHub `main` 已启用管理员同样受约束的 Branch Protection：必须走 Pull Request、
  与主线同步、解决 review conversation，并通过 macOS、Windows、性能、双架构发布、
  可复现性和 WorkBuddy 交付共 10 个 required checks；禁止 force-push 和删除主线。
- 验证基线：固定 Node `24.18.0`；每个主线候选继续经过本机 `pnpm verify` 与 GitHub
  macOS/Linux、Windows、性能、双架构发布、Windows 可复现性和 WorkBuddy 交付门禁。
  生产闭包仍是已验收并部署的 `51ba97b2e526`；后续源码合并均不等于已部署，也不得
  为部署重置资源采样窗口。
- 生产原则：库存公司业务不中断；任何运行中进程、状态、schedule 或有效 lease 存在
  时，只观察，不重启、不叠加触发。
- Rust 判定：暂不切换生产 Core，保留实现、测试和候选架构；完成阶段 0 数据采集后
  按准入门禁重新判断。
- Codex 判定：短期继续用于阅读、诊断、开发、页面观察和候选生成；正式运行最终不
  依赖 Codex。

公司跨端形态已明确为 Mac 唯一执行、Windows 远程控制面。当前候选新增 Console Viewer：
服务端拒绝除会话交换以外的业务写请求，前端隐藏自动化启动、任务处理、恢复、数据导入
与创作入口；Host 仍严格绑定 loopback，因此这只是本地安全边界，不是已完成远程部署。
仓库只能证实清退商品这一条 Windows 专属业务交付，用户所指第二条工作流入口待确认。

2026-08-09 的仓库只读审计已把“常驻 Core + 单共享 Chrome”收敛为灰度候选，而非提前
改写 normative 结论。当前资产证明库存 Chrome 使用一个 KeepAlive Profile，不是每任务
新建 Chrome；Team Worker 首次调用后单例复用；但 legacy inventory production-cycle 仍会
按步骤启动短命 Node/tsx 子进程，Native Host/Team Worker 退出所有权、Extension 重连、
标签页硬上限和常驻 Map 清理仍有工程缺口。现有 24 小时采样也不含这些子进程、标签页、
V8 heap、event-loop lag 与 Gateway 容量指标。本机当前没有 BPA launchd/进程，因此这只是
仓库形态审计，不能当作公司 Mac 当前进程事实。灰度候选、预算与停止线见阶段 1 计划。

## 2. 阶段状态板

| 阶段 | 状态 | 当前最重要缺口 | 退出证据 |
| --- | --- | --- | --- |
| 0 稳住上阵 | **进行中** | 结构收敛与生产热轮询修复已完成；24 小时资源曲线最终报告与 Core 7 天稳定性尚未验收 | 24 小时三类资源曲线、Core 7 天稳定 |
| 1 无人值守 | **开发中** | Recovery Session 控制台/远程通道、通知生产验收、固定 Trigger 覆盖 | 无 SSH 认证恢复、100% 失败推送、AI 触发占比持续降至零 |
| 2 造流程易用 | 未开始 | Web 校正界面、截图/元素候选回传、非技术用户验收 | 非技术同事独立完成真实流程发布 |
| 3 通用能力 | 未开始 | HTTP Request、File Write、JSON Transform、导出、自愈 | 不写 Adapter 覆盖主要通用需求 |
| 4 外部交付 | 未开始 | 单机安装、license、多用户权限 | 签名闭包安装、升级、回滚和权限验收 |

阶段 1 的前两层已进入主线：平台从 Run 问题终态生成脱敏 Attention，并把登录、验证码、
风控、`rejected`、`failed` 与 `uncertain` 呈现在统一 Operator Console。Schema v16 将
Attention 与终态写入同一事务，增加 open/acknowledged、revision CAS、确认审计和重启恢复；
缺少 Attention 的问题终态会整体回滚。Schema v17 Delivery Outbox、保守投递状态机和面板
对账已进入主线；独立飞书通知 Adapter 与严格 `0600` 配置加载也已通过 PR #16 进入主线，
但尚未配置真实 Channel。Schema v18 Recovery Session 持久状态机、仅本机 Console Host
的 CSRF 恢复入口和浏览器断线立即失效均已进入主线。手机推送生产验收、远程受限页面
通道和公司 Mac 灰度仍未完成，不能据此宣称无人值守成立。
实施顺序与共享 Chrome 资源边界见
`docs/plans/bpa-stage-one-unattended-operations-v0.1.md`。

## 3. Rust 准入状态

现有 `packages/inventory-kernel` 证明批量纯计算可以获得局部加速，但没有证明它能改善
浏览器主导的端到端延迟。当前只保留以下工作：

1. 保持 Rustfmt、Clippy、release build 和黄金一致性测试可运行。
2. 在 Node、Chrome、SQLite 分桶指标中记录真正的计算占比。
3. 不把 Rust Native Kernel 接入库存生产调用。
4. Node 侧瘦身后如果仍不满足 SLO，再评审独立 Rust Core 方案。

这是一项延后决策，不是删除 Rust 方向。

## 3.1 阶段 0 首次服务器测量

2026-08-06 19:00（Asia/Shanghai）完成第一轮只读核验：

- 生产目录存在，但不包含 `.git`；GitHub 是源码事实来源，生产目录是部署副本。
- 库存 Chrome 明确使用持久化的 `chrome-inventory-profile`；它当前由 launchd
  `KeepAlive` 常驻，不是每轮新 profile，也不是按需启动。
- 单点样本中 Core 约 195 MiB RSS、34.5% CPU；库存服务约 32 MiB RSS。
- BPA 库存 Chrome profile 共 11 个进程、约 1.23 GiB RSS。
- SQLite 主库约 1.43 GiB，WAL 约 7.6 MiB。单点文件大小不等于 page cache 占用。

以上只是一个瞬时样本，不能证明泄漏。已启动 60 秒间隔、持续 24 小时的只读 JSONL
采样，记录 Core/库存服务/Chrome 的 CPU 与 RSS，以及 SQLite/WAL/SHM 文件大小。采样
不读取进程命令正文、环境变量、数据库内容或页面内容，不触发工作流，也不持有租约。

新增 `scripts/analyze-macos-runtime-metrics.mjs` 作为确定性结论门禁。它校验时间顺序、
采样窗口、连续性和 PID 变化，并输出 RSS/CPU/Chrome 进程数的起止值、峰值与每小时
线性斜率。2026-08-06 20:26 的早期只读试算覆盖 86 个样本、约 1.42 小时，最大间隔
61 秒且无超过 120 秒的断点；Core、库存服务和 Chrome 均无 PID 变化，Chrome 进程数
保持 11。窗口不足 24 小时，因此不作泄漏或稳定结论。

分析器明确把 SQLite 标记为 `file_sizes_only`，并将 page cache 的配置与实际占用标记
为 `not_measured`。即使当前 JSONL 采样跑满 24 小时，也只能闭合 Node 与 Chrome 桶，
不能把数据库文件大小冒充 page cache 证据。

为关闭这个观测盲区，新增了隔离的 `@bpa/sqlite-observability` 原生扩展证明：它通过
SQLite 官方的 `sqlite3_db_status64`，在 better-sqlite3 持有的同一连接内返回 page
cache、schema 与 statement 内存；测试同时验证连接局部注册、SQL
`load_extension()` 仍被禁止、`shrink_memory` 后全表扫描会重新填充缓存，以及 macOS
bundle 不携带本机 install name 且重复构建字节一致。

第二层代码已经把扩展接到 `SqlitePersistence` 的唯一私有连接，由 Core 每 60 秒发布
mode `0600` 的原子白名单快照；采集器只复制通过 schema 校验的数字字段，分析器要求
快照新鲜、PID 与 Core 相同且 Runtime identity 非空。macOS arm64 闭包构建路径会把
内部 package 与 dylib 一起放入 manifest 哈希和 SBOM；Windows x64 在 DLL 门禁完成前
明确为 `unsupported_platform`，不能伪装为已测量。隔离 Core 已真实启动并写出
`cacheUsedBytes=823936` 的同连接快照，但这仍是临时空库代码证据，不是生产数值。
本轮正式 RC 闭包已完成 155 个文件的摘要验证，并通过打包态迁移、
socket、CLI、Team Worker 与 Extension E2E；这证明交付物包含该能力，但不等于已部署。

旧生产 sampler 不能追溯补入 page cache，且已经跨越 Core PID 切换，因此只作为切换前
诊断证据保留。生产闭包切换后已开启包含同连接 page cache 的新采样窗口。macOS
launcher 已改为闭包构建期生成并纳入 manifest，
固定写入 release identity；installer 在停止旧 Core 前核对 lock PID、可执行文件、
entrypoint 与 live command，启动新 Core 后再次核对精确 release，并为首次切换备份和
恢复原 launchd plist 与 Native Host manifest。installer 还会原子持有 install 与
maintenance 目录锁；受哈希的 Core launcher 只加载固定 `$BPA_HOME/core.env`，并要求
当前用户所有且权限为 `0600`，加载后再次覆盖可信 release identity。生产切换已通过
maintenance 后的 readiness 复核、库存 scheduler 暂停/恢复和 source-to-closure
故障注入 E2E。阶段 0 仍保持未完成，不得把首个生产样本或隔离测试写成完整 page
cache 曲线。

库存生产侧新增只读 readiness 判定器，统一核对 host/PostgreSQL 时钟、launchd PID、
原子状态文件、全表 running schedule/collection、有效 PostgreSQL 与 Browser Control
Lease、Core 健康及绑定页面认证状态。任何证据缺失或冲突都返回 `observe_only`；该工具
不获取租约、不写数据库，也不调用任何内部刷新实现。

## 3.2 阶段 0 首次生产闭包切换

2026-08-06 21:27 的最终切换检查发现真实库存周期正在运行，因此保持只读等待，没有
停止、重启或叠加触发。该周期于 21:49 自然终止为 `failed`，保留了已持久化事实；随后
复核为 recovery PID、有效 PostgreSQL/Browser Control lease、running schedule 和
running collection 全部为 0，状态文件与最新 collection 均为终态。

在该维护窗口内暂停库存 recovery launchd 后，首次生产 source-to-closure 安装完成：

- Runtime identity 为 `v0.6.0-rc.51ba97b2e526.node24.18.0`，Core PID 为 47140；
- SQLite 已迁移至 schema 13，三个热路径部分索引存在，待确认 outbox 为 0；
- `engine_outbox` 待确认查询计划命中 `engine_outbox_pending_created`，不再全表扫描；
- 安装前数据库备份位于受保护的 BPA backup 目录，install 与 maintenance 锁均已释放；
- 10 轮 `doctor`、Browser Session 和页面观察请求的进程级往返约 34–48 ms。

首次安装后的浏览器握手暴露了一个交付边界错误：库存 Chrome launchd 仍从源码目录
`apps/extension/.output` 加载扩展，因此已安装 Core 拒绝该 build。修正为稳定安装目录
`~/Library/Application Support/BPA/extension` 后，launchd 从干净状态加载成功；Core
报告 Browser Bridge `connected=true`、`ready=true`，配置的 Browser Instance 有 1 个
当前会话、2 个 `authenticated + ready` 页面和 0 个阻断页。仓库门禁现会拒绝任何重新
指向源码构建的库存 Chrome plist。

22:04 已恢复 30 分钟 recovery launchd，但没有 kickstart 或人工刷新。随后首个自然
周期于 22:32:30 启动，23:03:06 成功终止，launchd 退出码为 0。权威
`ops.collection_run` 为 `succeeded`，配置和完成均为 13/13；52 个 collection step
全部终态：13 个 canary succeeded、9 个 orders succeeded、4 个 orders fresh_reused、
13 个 inventory succeeded、13 个 risk succeeded。库存 attempted/persisted 为
319/319、failed 为 0，blocked/partial shop 均为 0，diagnostics 为空。状态文件为
`succeeded`，但自身没有 `completedShopCount` 字段，因此 13/13 结论只来自数据库权威
行，不从状态文件反推。

第二个自然周期于 23:33:07 启动，2026-08-07 00:01:43 成功终止，证明恢复不是一次性
人工闭包。权威 collection 仍为 13/13、52 个 step 全部终态：13 个 canary、13 个
inventory 和 13 个 risk 均 succeeded，orders 为 5 个 succeeded 与 8 个 fresh_reused；
库存再次为 attempted/persisted 319/319、failed 0，diagnostics 为空。状态文件、launchd
exit 0、数据库终态、recovery PID、running schedule/collection、有效 PostgreSQL lease
和 Browser Control lease 全部收敛，过程中没有人工触发、重启或浏览器动作。

终态后 recovery PID、running schedule、running collection、有效 PostgreSQL lease 和
Browser Control lease 均为 0。Core 仍是 PID 47140，Chrome launch PID 48106；Browser
Bridge connected/ready，1 个活动 Session、2 个 `authenticated + ready` 页面、0 个
阻断页。以上关闭了上一轮 lease renew unconfirmed 的生产回归，但不替代长期稳定门禁。

旧资源样本跨越 Core PID 切换，已经终止并保留；新 24 小时窗口从 Core PID 47140
重新计时，同时采集同连接 `sqlite3_db_status64`。截至 2026-08-07 00:03，120 个样本
覆盖约 1.99 小时，最大间隔 61 秒，无超过 120 秒的断点或缺失服务 PID；120/120 Core
metrics 可用，Core、Chrome 和库存 Monitor PID 均未变化，Runtime identity 固定为
生产闭包，同连接 cache 使用值保持稳定。该窗口仍不足 24 小时，不能据此得出长期稳定
或内存泄漏结论。

2026-08-09 回读完整样本得到 1439 个连续样本，覆盖 23.9972 小时；最大间隔约 60.19
秒，Core PID、Runtime identity、库存 Monitor PID、Chrome profile 和同连接 SQLite
page cache 均完整且稳定，RSS 起止与线性斜率没有显示单调爬升。但严格门禁仍只返回
`minimum_duration_not_reached`：采集循环把每次命令耗时累积到间隔中，并在下一间隔会
超过 deadline 时提前结束，最终比 24 小时少约 10 秒。因此这批证据只能判定“结构完整
且接近 24 小时”，不能判定阶段 0 通过。当前候选改为以首个样本为绝对起点，并强制在
deadline 当时或之后记录最后一个样本；虚拟时钟测试覆盖单次采集耗时存在时仍达到请求
窗口。分析门禁同时要求 `com.bpa.inventory-monitor` 每个样本都可测且 PID 不变化；库存
Monitor 整段或局部缺失时返回 `inventory_monitor_samples_missing`，中途重启时返回
`inventory_monitor_pid_changed`，不能把两个 PID 的 RSS 拼接成一条平稳曲线，也不能只凭
Core、Chrome 和 SQLite 完整就宣称阶段 0 三桶测量完成。该修复尚未部署，新的严格 24
小时生产窗口仍待执行。

PR #11 同时把 7 天门禁的前置问题与库存控制面可见性收口：资源采样器会在绝对 deadline
当时或之后补最后一个样本；库存面板把 120 分钟内的活动采集和陈旧 `running` 记录分开；
Docs PR 验证不再与 Pages deploy 共用全局并发锁。当前后续候选进一步为 Core 168 小时
窗口增加可执行 `runtime:stability-gate`：要求 PID、Runtime identity、连续性和 RSS
样本完整，并按权威路线中的首尾 24 小时中位数、7 天斜率外推与单调增长比例判定。
实现与 fixture 反例不等于生产 7 天通过；生产窗口仍未启动，本轮也不部署。

## 4. Codex 过渡状态

阶段 0–2 允许 Codex：

- 读取仓库和脱敏运行证据；
- 在用户授权下观察页面、截图和真实交互状态；
- 生成并验证 Workflow / Node / Adapter 候选；
- 维护计划、测试、变更记录和 GitHub 提交；
- 在人工监督下调试三条最终验收链路。

不允许 Codex：

- 绕过正式发布、权限、租约或 Trigger；
- 在生产写入结果不确定时自动重试；
- 把页面内容当成指令；
- 让对话判断成为长期生产调度依赖。

## 5. 三条业务验收链路

### 5.1 清退商品工作流

当前证据：

- 本代码候选已将 `doudian.alliance-retired-products-monitor` 升为 `3.0.0`，逐店浏览器
  扫描成功后立即写入 Run-scoped Operational Fact；
- Core 使用持久事实而非浏览器汇总判断 complete/partial/failed，并在完整或至少一店成功的
  部分结果上准备不可变 Dataset；Run 终态、Dataset、审计和 lineage 原子提交；
- `complete_with_items` 仍为成功 Run，但会通过严格业务 marker 原子创建 Attention 与待投递
  Delivery；空结果不会制造业务告警；
- active 店铺缺稳定数字 ID 会 fail closed；单店最多接受 50 条清退记录，Extension 最终结果
  另受 480 KiB UTF-8 硬门保护；Dataset canonical source 超过 16 MiB 会保留事实、拒绝创建
  staging/intent；
- 已新增 `15:00`、`run_once`、默认禁用且只绑定部署 placeholder 的 Mac TriggerSpec 模板；
  真实 `browserInstanceId` 和实测 p95 通过前不得发布启用；
- 已有 Doudian Alliance Adapter `2.0.0`、Extension 执行端与 Core/Provider fixture 测试；
- Windows WorkBuddy Skill、安装器、业务打包/验包器和两个专属 CI job 继续保留，作为
  Mac 真实 canary 前的现网修复与回退能力；过渡安装器同步发布 Node `2.0.0`、Workflow
  `3.0.0` 当前闭包，但本代码变更不会部署它；登录态真实页面完整 E2E 尚不能据此判定完成。

2026-08-07 的交付候选进一步收紧 `ready`：安装器必须重新读取 smoke test 写入的
日记录，核对最后一次 Run、完整扫描状态、已发现/已扫描店铺数相等且失败店铺为 0，
才返回 `acceptance.recordVerified=true`。该门禁消除了“命令返回成功但落盘记录或
店铺覆盖不完整”被误报成部署完成的可能。

2026-08-07 后续产品决定将清退商品的正式部署目标改为公司 Mac，与库存、体验分和
后续抖店工作流共享一个 BPA 管理的 Chrome 实例、Profile、`browserInstanceId` 与账号级
并发键。Windows WorkBuddy 官方交付源码、安装器、业务打包/验包器、两个专属 CI job 与
Branch Protection 的 10 项检查继续保留，直到公司 Mac 登录态真实 canary 与生产接管成立。
当前仍未部署该 Mac 版本；停止旧 WorkBuddy 任务及删除旧交付必须是 canary 后独立 PR 与
另行授权的生产窗口，不能由本代码候选提前完成。

剩余验收：真实登录页逐店完整扫描、分页、店铺恢复、失败语义、证据链和告警回归。

本阶段反思：消除的真实风险是浏览器汇总假持久化、Windows 日记录单点和成功发现无平台
Attention；当前证据仍属于 Node/Provider/Runtime fixture 与本机门禁，不是生产或真实页面
证据；旧 WorkBuddy 交付和 10 项保护检查仍完整保留，避免在 Mac canary 前失去现网修复能力；
目标控制面是 Mac Trigger，但运营 Windows 上旧任务是否仍运行待生产核验；下一最高收益瓶颈
是同一受管 Profile 的真实登录 E2E，而不是继续增加业务节点。

### 5.2 库存监控工作流

当前证据：

- 公司 Mac mini 已有正式 launchd 生产入口和 13 店恢复成功的交接记录；
- 已有订单、库存、预测、风险和控制租约的分层事实；
- 现网仍由 `apps/inventory-monitor` 的 serialized production cycle 控制；本代码候选已形成
  正式 13 店 Workflow，但尚未部署、未接管生产；
- 交接成功是历史证据，每次生产操作前仍需重新只读核验。

2026-08-06 的只读 Trigger 审计进一步确认：完整 13 店周期仍由 launchd 和
`production-cycle.ts` 编排，不是一个已发布 Workflow。PR #3 已让 Workflow 的
`rejected` 成为不可恢复的真实终态；当时 Trigger Run 仍没有钉死不可变的 TriggerSpec
快照，并会压缩 Workflow 终态。2026-08-09 已修复版本血缘与终态保真；后续继续补人工
actor 审计和策略执行，再迁移库存编排。不得用一个仅调用旧
脚本的壳 Node 伪装成产品 Workflow。

2026-08-06 20:59 的生产只读复核发现最新周期失败于
`BROWSER_CONTROL_LEASE_RENEW_UNCONFIRMED`：当时有效 Browser Control Lease、运行中
schedule 和 collection 均为 0，但该周期只完成 1/13 店。该店已经持久化了可用库存，
因此这是“部分库存事实 + 控制面失败”，不是“没有数据”。诊断同时记录订单浏览器请求
超过 120 秒、租约续期请求超过 30 秒，以及租约过期后的 malformed response。

根因已在本地代码和生产只读数据间闭合。生产 Core SQLite 主库约 1.53 GB，其中
`engine_outbox` 约 408 MB、共 48,347 行，待确认行为 0；但 Core 每 500 ms 执行的热
轮询没有条件索引，查询计划仍为全表扫描并使用临时排序树。单线程 Core 因此会在库存
浏览器操作期间失去响应，先导致业务请求超时，再导致控制租约错过续期窗口。另一个
协议缺陷会把 SQLite 返回的 `undefined` 经过 JSON 序列化后删除 `result` 字段，从而
把明确的租约丢失误报为 malformed envelope。

当前修复候选增加 Schema v13 的三个热路径部分索引，并把跨控制协议的“无租约”明确
编码为 `null`。查询计划测试、控制协议 E2E、租约 fail-closed 测试和固定 Node 24
typecheck 已通过；生产已部署精确 RC，现场 schema、索引和查询计划复核通过。修复后的
首个自然 13 店周期已经完整成功，租约续期与终态清理均闭合；业务恢复已由生产证据确认，
但 24 小时和 7 天稳定性门禁仍未完成。

2026-08-09 已合并的 Trigger 血缘修复新增 Schema v15：`trigger_spec_versions` 以
`triggerId + triggerVersion` 保存不可变执行配置；`enabled` 单独作为带 CAS 和审计的
当前控制状态。活动 Trigger Run 恢复、续租和释放只使用其已记录版本，不再回读同 ID
的当前配置。Trigger Run 同时原样保留 Workflow 的
`rejected`、`uncertain`、`cancelled`、`failed` 终态。该修复已通过 10 项 required checks
并进入主线，但尚未部署；库存仍由原生产控制面运行。

2026-08-09 PR #19 已增加 Schema v19 与 Trigger 浏览器控制租约：声明
`browserInstanceId` 的 Trigger Run 在整个 Workflow 生命周期同时持有业务并发租约和
`browser-instance:<id>` 租约，后者 fencing token 随 Trigger Run 持久化并在每次 tick
续租；Workflow Run 的创建与 Trigger Run 关联在同一 SQLite 事务提交，启动中断不会留下
可执行的孤儿 Run。清退、库存、体验分即使使用不同业务并发键，只要绑定同一个受管浏览器
实例就不能重叠；浏览器被库存或 Recovery Session 占用时 occurrence 明确 `skipped`，不会排队或
启动新 Chrome。丢失浏览器租约时 Trigger fail-closed，且不能释放后来控制者的租约。
三工作流本机 fixture 已覆盖占用、跳过、终态释放和接管；该层已进入主线但尚未部署，
也不等于三条真实页面 E2E 已完成。

Schema v20 已随 PR #22 进入主线，不再把一次 Trigger Run 同时当作计划事件和执行尝试。它新增持久
TriggerOccurrence、TriggerAttempt 和 Schedule cursor，Schedule 改为显式 daily/interval、
IANA timezone、固定 anchor 与 on-time window；`skip`、`run_once`、
`bounded_catch_up` 已由 Runtime 执行。业务或浏览器租约忙时 occurrence 进入
`deferred + nextAttemptAt`，不创建 Attempt、不消耗重试次数，也不启动额外 Chrome；三条
同到期 Workflow 的 fixture 已证明释放后继续串行。活动 Occurrence/Attempt 查询没有最近
200 条截断，Attempt 与 Occurrence 终态在同一 SQLite 事务提交。该层尚未部署。

Schema v21 已随 PR #23 进入主线，把 pre-Run `blocked/failed/missed/skipped` 终态与
`dashboard-only` Attention 放在同一 SQLite 事务；没有 Workflow Run 的 Attempt 只允许
以 `blocked/failed` 终止，旧版 Workflow 被 Trigger 调用时在创建 Run 前即安全阻断。库存
指挥台只通过 Core UDS 读取属于 `inventory-monitor` 的开放 Trigger Attention，不确认、
恢复、投递或写库存数据库；响应畸形或读取失败会显示“BPA 触发状态暂不可读”，不能显示
运行正常。这些提醒有严重度但不会触发外部 Delivery 或浏览器桌面通知。Operator Console
同时把 Attention 查询失败视为 action、把 information/review 视为 attention，并对 Viewer
使用固定脱敏文案。Schema 20 的旧 Attention、Delivery 或 Recovery Session 任一非空时，
Schema 21 明确拒绝升级并保持数据库原样；正式部署前必须先导出、退役并完成空库门禁。
该层已通过完整门禁但尚未部署，因此生产库存面板当前还看不到这些提醒。

对抗审查后，候选已升为不兼容旧计划形状的 `bpa.trigger/v1alpha2`：旧 Schema 19 库中
只要仍存在 TriggerSpec 或 Trigger Run，Schema 20 升级就明确拒绝并保持数据库原样，不能
直接用于生产热升级。大于 1000 个周期的积压改为每 tick 有界分页，未追平前不启动旧页
候选；单个 Trigger 失败只形成聚合错误，不阻断其他 Trigger 物化。计划时间统一为毫秒级
UTC，查询同时按 SQLite 时间值比较；时钟回拨不会缩短既有租约，终态 Attempt 遗留
租约在下一 tick 清扫。Attempt 持久化前崩溃的租约仍保守等待最长 300 秒 TTL，避免多
Core 竞态下错误释放有效控制权。正式部署前仍必须完成旧控制面导出/清退、备份和空库门禁。

后续本机正式资产 E2E 发现 Trigger 曾把内部 occurrence 元数据注入 Workflow 业务输入，
导致声明 `additionalProperties: false` 的清退、体验分和库存 Workflow 在 Run 创建前全部
被阻断。当前候选已移除这项输入污染：occurrence 与 Dataset 血缘只保留在不可变
Trigger Run，Workflow 只接收其已冻结业务输入。候选同时用同一 Browser Session 依次
走通清退商品 `2.0.1`、体验分 `2.0.0`、库存 `2.0.0` 的 Trigger、资源绑定、IR2、Provider、
终态与租约释放，并把普通单店失败改为 `collect` 后聚合为 `uncertain + partial`；登录、
验证码和风控的 `rejected` 仍立即终止。该测试不启动 Chrome，不等于真实登录页 E2E。

2026-08-10 的库存正式化候选新增 Schema v24 与 Core-owned external domain lease。声明库存
外部租约的 Trigger 先持久 acquisition intent，再以同一 request ID 向库存 PostgreSQL
Provider 幂等申请 `inventory-production-cycle`；租约忙时 occurrence 保持 deferred 且不创建
Attempt。远端 grant、TriggerAttempt 与 Workflow Run 绑定后，`inventory.snapshot.persist@2`
才允许由 Core 内 `inventory-data` Provider 派发。Workflow 输入已删除 lease，fencing token
只从 Run 绑定的可信上下文注入库存 UDS；PostgreSQL 每个库存写事务在同一连接先以
`SELECT ... FOR UPDATE` 校验 owner、token 和数据库时钟，再提交幂等账本与业务事实，关闭
了“先校验、后换事务写入”的 stale-owner 窗口。租约丢失或写入响应不确定时 Run 进入
`uncertain + reconciliation_required`，不得自动重试；业务写入对账未完成时，本地租约和
Attempt 保持阻断，不能只因远端 lease 可释放就让下一轮接管。Core 重启后必须先远端 read
验证同一 owner 和 token，才能恢复派发；Core 时钟跳变不能延长 PostgreSQL 租期。

本代码候选现已完成固定 13 店的正式
`doudian.inventory.production-cycle@1.0.0`：店铺 ID 与名称在任何浏览器/库存写入前做唯一性
校验；一个 Run、一个 Browser Slot、一个外部 PostgreSQL lease 串行完成切店、WDT 订单
新鲜度、逐商品快照事实、店级预测/风险批处理和源店恢复。首版每店最多 250 个商品，已知
真实单店记录为 86；Compiler 最坏执行步数为 9,889，仍低于 10,000，251 条失败关闭。
普通商品失败保留已持久事实并形成 `partial + uncertain`；预测/风险写入结果不确定时，Run
输出明确带出已持久化快照计数并进入对账阻断，不会显示“无数据”。

库存服务候选同步升级为 WDT-only staged publication：订单 chunk 只写 staging，最终在同一
fenced PostgreSQL 事务中 promote canonical facts、发布
`sales-demand-staged:<shopId>`、推进 watermark 并完成 sync；失败且成功清理 staging 时是
确定性 degraded，提交或清理结果未知才进入 reconciliation。旧 v5 订单事实和 watermark
物理归档到 `legacy` schema，新预测只读取带 `publicationProtocol=staged-v1` 的发布版本。
当前本机 fixture 已覆盖 13 店完整周期、单店部分失败、重复清单零副作用和预测写入不确定，
但没有真实 PostgreSQL/MySQL/登录 Chrome 证明，也没有部署到公司 Mac。

现网 serialized `production-cycle.ts` 与其 launchd 入口仍保留到真实 canary 和无中断切换；
这不是“双控制面可并跑”的许可。启用新 Trigger 前必须在同一维护窗口停用并只读确认旧
launchd、进程、活动周期和有效 `inventory-production-cycle` lease 全为空；新链路验收后再按
无兼容层原则删除旧执行路径。库存面板异常已能通过 Workflow Attention 展示，但正式
Workflow 的成功周期历史仍未替换 legacy `ops.collection_run/step` 视图，因此也属于部署前
门禁。

Schema v22 已随 PR #24 把体验分的“已持久化”从聚合文案改成可审计事实：每店页面读取后，
由 Core 内 `experience-data` Provider 立即写入 Run 级不可变 Operational Fact；业务日固定
来自 TriggerOccurrence 的计划时间，人工 Run 则固定来自 Run 创建时间。`no_score` 是成功
事实，停用店铺是正常跳过，普通店铺失败在已有事实时形成 `partial + uncertain`。完整与
部分结果都先准备不可变发布意图，再与 Run、checkpoint、审计和 lineage 在同一 SQLite
事务中发布 `doudian-experience-daily` Dataset；零事实、登录/验证码/风控拒绝、取消或发布
标记丢失均不发布。Trigger 或浏览器租约丢失时，Runtime 必须先把已关联 Workflow Run
持久取消并请求浏览器侧取消，再收口 Attempt/Occurrence，防止失去控制权的旧 Run 继续
写事实。旧 Extension 体验分聚合能力已删除，浏览器只负责读取页面快照。

体验分 Adapter、店铺发现 Node 与单店快照 Node 已升到 `2.0.0` 并清退旧源码执行路径；
对应 Runtime/Extension 发行身份整体升为 `0.6.1`，Adapter minimumVersion 同步锁定。
DatasetVersion 目前以内嵌 schema/normalization 形成整体摘要，不生成伪造的
dataset_profile closure ref；正式版本化 dataset_profile 的发布与闭包解析仍是部署前门禁。

这一层已随 PR #24 通过本机完整门禁、对抗审查和 GitHub 10 项 required checks 进入主线；
真实登录页逐店验证、公司 Mac 灰度与生产 Dataset 仍待确认。质量感知的
`latest complete/latest attempt` 视图尚未实现，因此不得把该 Dataset 接入 Dataset Trigger，
也不得在 Console 中称其为“最新体验分”。正式 `dataset_profile` 资产及其覆盖 record
schema 与规范化语义的 digest 也尚未发布；当前候选不把进程内常量伪装成 IR2 已发布
闭包，该资产是后续发布和灰度部署的硬门禁。

2026-08-09 只读生产复核显示最新自然周期于 11:54（Asia/Shanghai）成功终止：13/13
店完成，库存 319/319 持久化、失败 0，四类共 52 个步骤均为终态；当前有效租约和运行中
schedule 均为 0。与此同时，`ops.collection_run` 仍保留一条约 37 小时前开始且标记为
`running` 的陈旧记录，只有部分店铺步骤，和当前进程、租约及最新成功周期构成控制面
矛盾。它不代表采集仍在执行，也不能作为等待或补触发依据。当前面板候选把 120 分钟内
的 `running` 与陈旧记录分开：前者才允许显示“库存正在更新”，后者在全店和单店概览
显示一次“采集控制记录未收口”严重告警，并明确要求先核对进程、租约和步骤终态、不要
补触发。候选未部署，也没有修改这条生产记录。

候选 RC 已完成首次 source-to-closure 故障注入：在隔离 Home 和 v12 临时数据库中，
强制让新 launch agent bootstrap 以状态 42 失败。installer 随后恢复了旧 launchd
plist、Native Host manifest、Extension 与 v12 数据库，删除了新 Runtime 指针和安装
目录，释放 install/maintenance 两把锁；恢复后的数据库 `integrity_check=ok`，并再次
尝试 bootstrap 旧 agent。该证据没有触碰生产 Home 或生产进程。

2026-08-06 21:21 的第二次生产只读 readiness 为瞬时 `idle_ready`：无 recovery PID、
无 PostgreSQL/Browser Control Lease、无 running schedule/collection；Core 与浏览器
桥接可达，库存 Browser Instance 有 1 个连接会话、2 个 authenticated ready 页面、
0 个阻断页面。检查同时暴露 readiness 请求上限 500 与持久层最大 200 不一致；候选已
统一为 200 并通过控制协议与 readiness 测试。`idle_ready` 不是持续许可，正式切换前
必须再次运行同一检查，任何新周期或租约出现都立即回到 `observe_only`。

剩余验收：连续稳定窗口、固定 Trigger、统一控制台、登录失效恢复，以及业务能力迁入
正式 Node / Workflow 后的无中断切换。

### 5.3 爆款图片证据流

当前证据：

- 已有 `ecommerce.evidence-chain-replay` Workflow；
- 已有证据评估、可比池、参考包和内容寻址相关领域能力；
- 已有预制输入 fixture，但它不能证明真实页面图片资产已采集并可复用。

2026-08-07 对归档的 2026-07-29 预包装煎饼 smoke 包执行了新的只读闭包校验：
3 个入选主图均能在各自来源 manifest 中找到，文件签名、媒体类型和 SHA-256 与
Workflow fixture 一致，且来源 URL 均属于抖音商品图片 CDN。闭包状态明确为
`source_verified_rights_pending`；公开可访问不等于已取得再分发授权，所以当前只允许
内部参考，不能写成“来源授权已完成”。该校验也没有把原图导入 BPA CAS，不能据此声称
控制台已经可以下载参考包。

剩余验收：在明确授权和 Page Binding 下采集原图、来源、时间、业务指标与页面证据，
形成可下载的参考资产包，并完成回放、去重、权限、失效和 Web 控制台展示。

## 6. GitHub 提交规则

- 每个提交只包含一个可解释边界：规范/文档、Runtime、库存业务、清退业务或证据流。
- 提交前运行与改动范围相符的测试；阶段基线和发布提交运行 `pnpm verify`。
- 提交后及时推送当前 `codex/` 分支，不让生产修复长期只存在于公司机器或脏工作区。
- 不提交运行数据、凭据、Cookie、验证码、签名私钥、source map 或本地分析产物。
- 不为保留旧路径增加兼容层；新路径验证完成后删除被替代实现。

## 7. 当前执行顺序

1. ~~将当前工作区按规范、协议/Trigger、库存生产、Rust Kernel 分组并分别验证提交。~~
2. ~~为当前 JSONL 增加确定性分析器，且把 SQLite 文件大小与 page cache 证据分开。~~
3. ~~完成 Core 热轮询索引与控制租约空结果协议修复的正式门禁，并在没有运行中
   schedule、collection 或有效 lease 的维护窗口内完成首次 source-to-closure 切换。~~
4. 修复后的采样器重新取得不少于 24 小时的 Core、Chrome 和 SQLite 同连接 page
   cache 窗口；上一窗口因少约 10 秒未通过严格门禁，不得四舍五入为完成。
5. 启动 Core 7 天稳定性窗口并记录重启、RSS 趋势与运行事件。
6. ~~修复 Trigger 版本钉死与终态保真。~~ 已通过完整门禁并进入主线；随后进入阶段 1
   的登录恢复、告警和统一控制台。
7. 依次完成清退商品、库存监控、爆款图片证据流的正式产品回归。
