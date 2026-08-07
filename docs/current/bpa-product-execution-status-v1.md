# BPA 长期产品执行状态 v1

> 文档类别：当前执行状态与阶段证据索引。
> 记录时间：2026-08-06。
> 权威等级：current-state。本文件记录"现在做到哪里"，产品边界和阶段顺序分别以
> `docs/normative/bpa-product-form-v1.md` 与 `docs/normative/bpa-roadmap-v1.md` 为准。

## 1. 当前判定

- 当前阶段：**阶段 0，稳住上阵**。
- 当前分支：`codex/phase0-observation`，只记录阶段 0 观测证据，不部署新 Runtime。
- Git 基线：PR #2 与 PR #3 均已在全部发布门禁通过后合并到 `main`，merge commit 分别为
  `5e091af7fbb0` 与 `58bfc108238f`。阶段 0 的结构收敛、Workflow `rejected` 终态保真、
  资源观测加固和 Windows 文件锁重试均已进入主线。
- GitHub `main` 已启用管理员同样受约束的 Branch Protection：必须走 Pull Request、
  与主线同步、解决 review conversation，并通过 macOS、Windows、性能、双架构发布、
  可复现性和 WorkBuddy 交付共 10 个 required checks；禁止 force-push 和删除主线。
- 验证基线：固定 Node `24.18.0` 下 PR #3 候选 `pnpm verify` 通过，126 个测试文件、
  775 项测试全绿，文档 Catalog 80 条有效，Astro 0 诊断。GitHub 的 macOS/Linux、Windows、
  性能、双架构发布、Windows 可复现性、WorkBuddy 发布及 Windows 安装验证全部通过。
  生产闭包仍是已经完整验收并部署的 `51ba97b2e526`；PR #3 已合并但未部署，不得以代码
  合并替代生产证据，也不得为部署重置当前 24 小时采样窗口。
- 生产原则：库存公司业务不中断；任何运行中进程、状态、schedule 或有效 lease 存在
  时，只观察，不重启、不叠加触发。
- Rust 判定：暂不切换生产 Core，保留实现、测试和候选架构；完成阶段 0 数据采集后
  按准入门禁重新判断。
- Codex 判定：短期继续用于阅读、诊断、开发、页面观察和候选生成；正式运行最终不
  依赖 Codex。

## 2. 阶段状态板

| 阶段 | 状态 | 当前最重要缺口 | 退出证据 |
| --- | --- | --- | --- |
| 0 稳住上阵 | **进行中** | Core 热轮询修复后的首个自然 13 店周期已成功；PR #3 已合并，新 24 小时资源曲线与 Core 7 天稳定性尚未验收 | 24 小时三类资源曲线、Core 7 天稳定 |
| 1 无人值守 | 未开始 | 登录失效恢复、失败推送、统一控制台、固定 Trigger 覆盖 | 无 SSH 认证恢复、100% 失败推送、AI 触发占比持续降至零 |
| 2 造流程易用 | 未开始 | Web 校正界面、截图/元素候选回传、非技术用户验收 | 非技术同事独立完成真实流程发布 |
| 3 通用能力 | 未开始 | HTTP Request、File Write、JSON Transform、导出、自愈 | 不写 Adapter 覆盖主要通用需求 |
| 4 外部交付 | 未开始 | 单机安装、license、多用户权限 | 签名闭包安装、升级、回滚和权限验收 |

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

- 已有 `doudian.alliance-retired-products-monitor` Workflow；
- 已有逐店扫描和汇总 Node；
- 已有 Doudian Alliance Adapter、Extension 执行端与 fixture 测试；
- 安装/CI 证据存在，但登录态真实页面完整 E2E 尚不能据此判定完成。

2026-08-07 的交付候选进一步收紧 `ready`：安装器必须重新读取 smoke test 写入的
日记录，核对最后一次 Run、完整扫描状态、已发现/已扫描店铺数相等且失败店铺为 0，
才返回 `acceptance.recordVerified=true`。该门禁消除了“命令返回成功但落盘记录或
店铺覆盖不完整”被误报成部署完成的可能；它仍不替代运营 Windows 电脑上的登录态
真实页面 E2E。

剩余验收：真实登录页逐店完整扫描、分页、店铺恢复、失败语义、证据链和告警回归。

### 5.2 库存监控工作流

当前证据：

- 公司 Mac mini 已有正式 launchd 生产入口和 13 店恢复成功的交接记录；
- 已有订单、库存、预测、风险和控制租约的分层事实；
- 当前实现仍高度依赖 `apps/inventory-monitor`，尚未完成产品 Workflow/Trigger 收敛；
- 交接成功是历史证据，每次生产操作前仍需重新只读核验。

2026-08-06 的只读 Trigger 审计进一步确认：完整 13 店周期仍由 launchd 和
`production-cycle.ts` 编排，不是一个已发布 Workflow。PR #3 已让 Workflow 的
`rejected` 成为不可恢复的真实终态，但 Trigger Run 仍没有钉死不可变的 TriggerSpec 快照，
并仍会压缩 Workflow 的 `rejected` / `uncertain`。阶段 0 门禁完成后，先修复 Trigger
版本血缘、触发层终态保真、人工 actor 审计和策略执行，再迁移库存编排；不得用一个
仅调用旧脚本的壳 Node 伪装成产品 Workflow。

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
4. 等待并分析新 Core、Chrome 和 SQLite 同连接 page cache 的 24 小时采样结果；首个
   自然 13 店周期已成功，不再需要人工补触发。
5. 启动 Core 7 天稳定性窗口并记录重启、RSS 趋势与运行事件。
6. 修复 Trigger 版本钉死与终态保真，再进入阶段 1 的登录恢复、告警和统一控制台。
7. 依次完成清退商品、库存监控、爆款图片证据流的正式产品回归。
