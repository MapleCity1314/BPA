# BPA Mac 唯一执行与 Windows 远程操作计划 v0.1

> 文档类别：公司部署与远程操作计划。
> 记录时间：2026-08-09。
> 实现状态：部分实现；Console Viewer 服务端边界、前端只读形态、清退商品 Mac 事实/Dataset/
> Attention vertical slice 与默认禁用 TriggerSpec 已形成代码候选。WorkBuddy 官方交付源码、
> 10 项保护检查、远程身份、Operator 调用、真实浏览器验收、Trigger 正式启用和生产停旧任务
> 均尚未完成切换或清退。
> 上位约束：`docs/normative/bpa-product-form-v1.md`、
> `docs/normative/bpa-roadmap-v1.md`。

## 0. 决策

公司工作流采用 **Mac 唯一执行，Windows 远程查看和受控发起请求**：

```text
Windows 浏览器 / 薄客户端
        │ 私网 HTTPS；首阶段只读
        ▼
Mac Remote Operator Gateway
        │ 固定业务方法映射；不透传 Control method
        ▼
Mac Local Core → Trigger → Extension → 单一持久 Chrome Profile
        │
        └─ Run / Dataset / Evidence / Attention / Audit
```

Windows 不安装公司业务 BPA Runtime、Extension、Native Host 或抖店 Chrome Profile，
也不承担 Schedule。Windows 关机不得影响任何计划任务。通用 Windows x64 Runtime
仍可作为 P2 可选服务器能力保留；它不再决定公司业务的部署位置。

## 1. 两条 Windows 工作流的事实边界

现网与历史验收当前只可证明一条 Windows 专属业务交付：
`doudian.alliance-retired-products-monitor@2.0.4`。本代码候选将仓库中的过渡 WorkBuddy
Skill、PowerShell 安装器和两个 CI job 同步到 Workflow `3.0.5` 七资产闭包，以保留 canary
前的修复能力，但该候选尚未部署，不能把它写成现网版本或新的生产证据。

用户指出共有两条需要迁移，但第二条的 Workflow ID、Windows 调度入口、Profile 和
结果消费者在仓库中均 **待确认**。`doudian.priority-items-readonly-inspect@0.3.0`
只是候选，因为现有运维文档把它描述为 Mac Runtime；在事实入口确认前不得把它写成
Windows 生产，也不得删除其路径。

## 2. 权限模型

远程会话分为三种，不把“调用”伪装成只读：

| 角色 | 允许 | 禁止 |
| --- | --- | --- |
| Viewer | 脱敏 Dashboard、Run、Attention 与报告清单 | 所有业务写入、浏览器/恢复绑定、Catalog、Evidence lineage、技术细节和文件正文下载 |
| Operator | Viewer + 请求已允许的 Manual Trigger、CAS 启停、确认 Attention | `run.create`、任意输入、资产发布、浏览器控制、Design Mode |
| Maintainer | 仅 Mac 本机维护面 | 不通过远程 Gateway 暴露 |

第一阶段只实现 Viewer。Console Host 继续绑定 `127.0.0.1`，`viewer` 模式在服务端
拒绝所有业务写请求，前端同时隐藏自动化启动、任务处理、恢复、数据导入和创作入口。
Dashboard 与 Run 同时移除浏览器/恢复绑定和技术细节；文件正文下载在身份感知的分类授权
完成前保持关闭。Viewer Dashboard 不枚举 Recovery Session，避免一次 GET 因会话过期而
产生持久状态更新；生产前端不发布包含源码正文的 sourcemap。
这只证明只读应用边界，不等于远程网络和身份已经完成；不得直接改绑 `0.0.0.0`。

第二阶段新增常驻 Remote Operator Gateway，并只在公司私网/Tailscale 或现有公司
Gateway 的 HTTPS 身份层之后使用。Core UDS、SQLite、Native Messaging 和浏览器端口
始终不出 Mac。

## 3. 受控调用

Operator 只能提交稳定 `automationId + operationId`，不能提交 Workflow/Node 版本、
资源绑定、文件路径或任意 Control method。Gateway 从身份会话确定 actor，并将请求映射到
Mac 上已经发布并允许的 Manual Trigger。

请求必须异步返回 `operationId`；重复点击、响应丢失、客户端重启和 Gateway/Core 重启后，
同一 operation 只能对应一个持久 Trigger occurrence。Schema v20 候选已将
TriggerOccurrence 与 TriggerAttempt 分离并承担 occurrence 防重；正式开放前仍需补可信
actor 审计和远程操作查询投影。

## 4. 浏览器与性能

清退、库存、体验分及第二条已确认的抖店工作流固定到同一 Mac `browserInstanceId`，
共享 `browser-instance:<id>` 租约。默认复用一个持久 Profile 和一个业务标签页；只有跨域
且 Node 契约明确要求时才允许第二个临时标签页，并必须在 Node 结束前关闭。

浏览器租约只能约束 BPA 控制面，不能约束旧 launchd、Playwright/CDP、Windows WorkBuddy
或人工点击。生产切换必须先停旧入口、再启新 Trigger，禁止长期双轨。短期保留全 Workflow
粗粒度浏览器租约；纯聚合、事实写入、Dataset 发布和投递移出 Browser Runtime 后，只有
编译器能证明后续无浏览器步骤时才讨论提前释放。

## 5. 数据与调度前置门禁

1. 体验分的“逐店立即持久化”采用幂等事实表，唯一键至少包含 `runId + shopKey`；
   foreach 终态后再一次发布不可变 DatasetVersion。同日重跑产生新版本，partial 不能覆盖
   “最新完整结果”。
2. Schema v20 候选已实现 daily/interval 日历锚点、IANA 时区、持久 cursor、三种
   missed-run policy 和租约忙时的 `deferred`。Mac 正式接管日任务前还必须把 pre-Run
   `blocked/missed/skipped` 与 dashboard-only Attention 原子提交；当前不得声称问题已上面板。
3. 清退 Windows runner 当前负责 `YYYY-MM-DD.json/latest.json`。Mac 事实、Dataset、
   Attention 和远程结果投影成立前，不删除旧交付；替代闭环成立后应删除而非保留兼容层。

## 6. 分阶段交付

### A. 迁移边界与 Viewer

- 锁定第二条 Windows 工作流；
- 权威文档确认 Mac 唯一执行；
- Console `viewer` 在服务端 fail-closed，前端无写入口；
- 仍只在 loopback 本机测试，不宣称远程可用。

### B. Mac 本地业务闭环

- 清退与体验分逐店事实持久化、终态 Dataset、Attention；
- 日历 Schedule、missed-run 与冲突 coalescing；
- 单 Profile 下顺序运行正式 Workflow。

### C. 远程身份与 Operator

- HTTPS 私网入口、viewer/operator 身份、会话撤销；
- allowlist Manual Trigger、持久 operation、actor 审计、防重放；
- restricted Evidence 单独授权和下载审计。

### D. 真实与生产验收

- Mac 真实登录页、失败恢复、同到期不漏跑、24 小时 Chrome 曲线；
- Windows 关机不影响 Schedule，且不存在 BPA Runtime/Chrome/Native Host 进程；
- 另行授权后按单控制面逐条灰度，不与库存活动周期重叠。

### E. 删除旧交付

- **当前必须保留**：清退 WorkBuddy Skill、内置 Runtime/Extension 安装入口、安装器、
  业务专属打包/验包脚本、仓库硬门、两个专属 CI job 和 Branch Protection 10 项检查，作为
  Mac 真实 canary 前的现网修复与回退能力。过渡安装器只发布当前浏览器 Node `2.0.4`、Workflow
  `3.0.5` 闭包，不保留旧版本兼容资产；本计划阶段不部署该 Windows 包。
- **canary 后独立 PR**：Mac 登录态真实 E2E 和生产接管成立后，才删除上述业务旧交付；通用
  Windows Runtime RC 门禁仍保留。随后单独审计是否可移除 `release-workbuddy-skill` 与
  `validate-workbuddy-skill-windows` 两个 required contexts，其他保护不变。
- **待生产授权完成**：在运营 Windows 官方界面停止旧 WorkBuddy automation；确认没有运行中
  任务并保全记录后，再判断其 Runtime 是否专用并卸载。源码候选不等于生产旧任务已停止。

## 7. 阶段反思门

每完成一个阶段必须记录：消除了哪个真实风险；证据属于单测、Provider fixture、真实浏览器
还是生产；删除了多少旧路径；当前唯一控制面是谁；下一阶段是否仍是最高收益瓶颈。
不能回答这五项时停止堆能力并重新排序。
