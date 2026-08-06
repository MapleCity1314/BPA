# BPA 长期产品执行状态 v1

> 文档类别：当前执行状态与阶段证据索引。
> 记录时间：2026-08-06。
> 权威等级：current-state。本文件记录"现在做到哪里"，产品边界和阶段顺序分别以
> `docs/normative/bpa-product-form-v1.md` 与 `docs/normative/bpa-roadmap-v1.md` 为准。

## 1. 当前判定

- 当前阶段：**阶段 0，稳住上阵**。
- 当前分支：`codex/protocol-v2-decoupled-runtime`。
- Git 基线：本地分支与 `origin/codex/protocol-v2-decoupled-runtime` 同步，PR #2
  保持打开；当前精确提交以 `git rev-parse HEAD` 和 GitHub PR 为准，不在状态文档内
  复制一个会随提交立刻过期的哈希。该分支尚未合并或明确放弃，因此阶段 0 的 Git
  收敛门禁仍未完成。
- 验证基线：固定 Node `24.18.0` 下 `pnpm verify` 通过，macOS、Windows、性能与发布
  闭包 CI 全绿。本轮完整门禁为 121 个测试文件、753 项测试全绿，文档 Catalog 80 条
  有效，Astro 0 诊断。
- 生产原则：库存公司业务不中断；任何运行中进程、状态、schedule 或有效 lease 存在
  时，只观察，不重启、不叠加触发。
- Rust 判定：暂不切换生产 Core，保留实现、测试和候选架构；完成阶段 0 数据采集后
  按准入门禁重新判断。
- Codex 判定：短期继续用于阅读、诊断、开发、页面观察和候选生成；正式运行最终不
  依赖 Codex。

## 2. 阶段状态板

| 阶段 | 状态 | 当前最重要缺口 | 退出证据 |
| --- | --- | --- | --- |
| 0 稳住上阵 | **进行中** | PR 尚未收敛；24 小时资源曲线、SQLite page cache 实测和 Core 7 天稳定性仍缺失 | Git 分支二选一、`pnpm check`、三类资源曲线、Core 7 天稳定 |
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
线性斜率。2026-08-06 19:46 的早期只读试算覆盖 46 个样本、约 0.75 小时，连续性
正常，Core、库存服务和 Chrome 均无 PID 变化；窗口不足 24 小时，因此不作泄漏或
稳定结论。

分析器明确把 SQLite 标记为 `file_sizes_only`，并将 page cache 的配置与实际占用标记
为 `not_measured`。即使当前 JSONL 采样跑满 24 小时，也只能闭合 Node 与 Chrome 桶，
不能把数据库文件大小冒充 page cache 证据。阶段 0 继续保持未完成。

库存生产侧新增只读 readiness 判定器，统一核对 host/PostgreSQL 时钟、launchd PID、
原子状态文件、全表 running schedule/collection、有效 PostgreSQL 与 Browser Control
Lease、Core 健康及绑定页面认证状态。任何证据缺失或冲突都返回 `observe_only`；该工具
不获取租约、不写数据库，也不调用任何内部刷新实现。当前生产部署副本尚未切入此提交，
因此这里只构成代码与测试证据，不构成生产现场证据。

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

剩余验收：真实登录页逐店完整扫描、分页、店铺恢复、失败语义、证据链和告警回归。

### 5.2 库存监控工作流

当前证据：

- 公司 Mac mini 已有正式 launchd 生产入口和 13 店恢复成功的交接记录；
- 已有订单、库存、预测、风险和控制租约的分层事实；
- 当前实现仍高度依赖 `apps/inventory-monitor`，尚未完成产品 Workflow/Trigger 收敛；
- 交接成功是历史证据，每次生产操作前仍需重新只读核验。

2026-08-06 的只读 Trigger 审计进一步确认：完整 13 店周期仍由 launchd 和
`production-cycle.ts` 编排，不是一个已发布 Workflow；Trigger Run 没有钉死不可变的
TriggerSpec 快照，并把 Workflow 的 `rejected` / `uncertain` 压缩成较弱终态。先修复
版本血缘、终态保真、人工 actor 审计和策略执行，再迁移库存编排；不得用一个仅调用
旧脚本的壳 Node 伪装成产品 Workflow。

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
3. 等待并分析 Node、Chrome 24 小时采样结果；另补 SQLite page cache 的真实遥测。
4. 复用已有 macOS 预编译 Core 闭包，在隔离 `BPA_HOME` 验证后制定生产切换门禁；
   当前采样期间不替代生产 `tsx`。
5. 启动 Core 7 天稳定性窗口并记录重启、RSS 趋势与运行事件。
6. 修复 Trigger 版本钉死与终态保真，再进入阶段 1 的登录恢复、告警和统一控制台。
7. 依次完成清退商品、库存监控、爆款图片证据流的正式产品回归。
