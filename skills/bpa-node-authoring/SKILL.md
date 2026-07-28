---
name: bpa-node-authoring
description: 将 BPA Catalog 中缺失的稳定业务能力设计、生成或升级为最小权限 Node 候选。用于决定复用/组合/Browser Adapter/团队节点/人工节点，编写输入输出与错误契约，推导风险和权限，为 Browser Node 设计 PageModel 和 ElementContract 候选，调用 node_gen/node_requirement_create，并生成契约测试与实现边界。不要用于运行时执行任意代码、创建 control.* 或 data.* 内置节点、把临时选择器塞进 Workflow、绕过浏览器 Bridge 或自动发布。
---

# BPA Node Authoring

把一个能力缺口收敛为可测试的最小契约。优先组合现有 Node；只有无法组合时才提出新实现。

## 决策顺序

1. 用 `catalog_search` 搜索同义能力、相邻版本和可组合节点。
2. 能组合时选择 `composite`，只引用已发布 Node，不生成运行时代码。
3. 必须读取真实页面 DOM 时选择 `browser`，实现归属经过审查的 Adapter。
4. 必须执行确定性公司逻辑时选择 `engine_team`；只允许安装包内、摘要固定、Handler 白名单中的审核代码。
5. 需要 AI 分析、人工确认或人工操作时选择 `assistance`，并区分 `ai_review`、`human_confirm` 和 `human_action`。
   优先复用已发布 Profile：包装歧义 `packaging_match_review`、长期绑定 `binding_confirm`、范围确认 `scope_review`、登录风控 `auth_takeover`、结构异常 `adapter_anomaly_review`。
6. 仍不清楚契约时先调用 `node_requirement_create`，不要伪造 Node。

## 编写契约

1. 用动宾结构定义一个不可再拆的职责。
2. 编写严格 `inputSchema`、`outputSchema`、可选 `configSchema`。区分缺失、空值和未知字段。
3. 阅读 [node-contract.md](references/node-contract.md)，声明幂等、超时、取消点、错误码和证据。
4. 阅读 [permission-and-risk.md](references/permission-and-risk.md)，声明最小权限、精确 Origin 和不低估的风险。
5. 调用 `node_gen`。检查返回的最低风险、Provider、实现边界、CapabilityGap 和契约测试；生成物只能保存为 Candidate。
6. Browser Node 必须阅读 [page-discovery.md](references/page-discovery.md)，生成 Adapter 骨架、PageModel / ElementContract 候选和页面夹具测试；不得接收任意 JavaScript、远程脚本或页面指令。
7. 通过 Schema、契约、重复投递、超时、取消、权限、页面变化和恢复测试后，交给人工发布。

## 固定边界

- `control.*`、`data.*` 由 BPA Core 维护，普通 `node_gen` 不得占用。
- Dataset 只能通过不可变 `DatasetRef` 和受限读取 Node 使用；Team Worker 不得直连 Core SQLite。
- Team Worker 不动态加载模块、不继承环境秘密，也不作为恶意代码安全沙箱。
- 权限不能靠运行时“需要时再申请”；缺权限应拒绝并升级 Candidate。
- Domain 必须是精确 Origin，不得使用通配符、路径或宽泛站点授权。
- 页面元素定位是 Adapter 的版本化契约，不得写入 Workflow；页面身份或元素唯一性无法确认时必须失败关闭。
- 验证码、登录失效、平台风控和限流必须返回阻断信号，不得绕过。
- `verified_write` 必须有写前状态、写后验证和补偿说明。
- `non_repeatable` 不得自动重试；效果不明时返回 `uncertain`。
- Node Candidate 不能直接发布，也不能被未发布 Workflow 引用。
