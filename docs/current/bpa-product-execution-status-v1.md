# BPA 长期产品执行状态 v1

> 文档类别：当前执行状态与阶段证据索引。
> 记录时间：2026-08-06。
> 权威等级：current-state。本文件记录"现在做到哪里"，产品边界和阶段顺序分别以
> `docs/normative/bpa-product-form-v1.md` 与 `docs/normative/bpa-roadmap-v1.md` 为准。

## 1. 当前判定

- 当前阶段：**阶段 0，稳住上阵**。
- 当前分支：`codex/protocol-v2-decoupled-runtime`。
- Git 基线：本地 HEAD 与 `origin/codex/protocol-v2-decoupled-runtime` 已同步到
  `f7edc23`，工作区干净；本轮将历史改动拆为文档、Rust Kernel、Trigger、浏览器
  绑定、抖店采集与库存生产六个提交。
- 验证基线：Node `24.18.0` 下 `pnpm verify` 通过，119 个测试文件、746 项测试通过；
  文档 Catalog 80 条有效，Astro 0 诊断。
- 生产原则：库存公司业务不中断；任何运行中进程、状态、schedule 或有效 lease 存在
  时，只观察，不重启、不叠加触发。
- Rust 判定：暂不切换生产 Core，保留实现、测试和候选架构；完成阶段 0 数据采集后
  按准入门禁重新判断。
- Codex 判定：短期继续用于阅读、诊断、开发、页面观察和候选生成；正式运行最终不
  依赖 Codex。

## 2. 阶段状态板

| 阶段 | 状态 | 当前最重要缺口 | 退出证据 |
| --- | --- | --- | --- |
| 0 稳住上阵 | **进行中** | Git 与 browser profile 已收敛；24 小时资源曲线和 Core 7 天稳定性仍缺失 | 干净 Git 基线、`pnpm check`、三类资源曲线、Core 7 天稳定 |
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
2. 等待并分析 Node、Chrome、SQLite 24 小时采样结果。
3. 设计生产预编译启动路径；先在非生产闭包验证，再替代生产 `tsx`。
4. 启动 Core 7 天稳定性窗口并记录重启、RSS 趋势与运行事件。
5. 进入阶段 1，优先完成登录恢复、告警、统一控制台和固定 Trigger。
6. 依次完成清退商品、库存监控、爆款图片证据流的正式产品回归。
