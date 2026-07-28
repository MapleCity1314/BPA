---
name: bpa-workflow-authoring
description: 将真实浏览器或混合业务过程快速设计、生成、校验或升级为 BPA Workflow 候选。用于结构化业务目标、复用模板和已发布 Node、设计数据绑定与成功/异常路由、设置风险和人工边界、调用 workflow_gen/workflow_validate/workflow_simulate/artifact_diff，或识别需要 node_gen 和页面发现的能力缺口。不要用于直接操作浏览器、把选择器写进 Workflow、运行时临时编写代码或绕过发布审核。
---

# BPA Workflow Authoring

把业务目标沉淀为可独立运行、固定版本、可恢复审查的 Workflow。只创建 Draft 和
Candidate；正式发布必须由用户通过 CLI 确认。

## 工作流

1. 阅读 [fast-authoring.md](references/fast-authoring.md)，把自然语言整理为 ScenarioSpec。明确业务产出、触发条件、输入、输出和验收证据，把“点哪里”改写为“交付什么”。
2. 先用 Catalog v2 按能力、平台、输入输出、风险、权限和 Adapter 版本搜索已有 Workflow、Recipe 和 Node。只使用完整 `node_id@semver`；不得猜测 Node、版本或权限。
3. 读取 [risk-and-routing.md](references/risk-and-routing.md)，确定 Workflow 风险、失败出口、人工点和 `uncertain` 处理。
4. 创建带 revision 的小型 Workflow Draft。每次用 CAS 只增加或修改一个 Step、绑定、测试或异常策略；冲突后先读取最新 revision，不覆盖并发修改。
5. 使用 v1alpha2 的 `call`、`decision`、顺序 `foreach`、`wait.assistance` 和 `terminal`。绑定只允许 `${input...}`、`${steps.<key>.output...}`；foreach 内还允许 `${item...}`、`${index...}`。不得写 `${previous...}`。
6. 为每个外部动作补齐超时、有限重试和明确异常处理；为 foreach 固定 `itemKey`、`maxItems`、`maxDuration` 和 `onItemError`。
7. 依次校验 Candidate、模拟代表性样例并查看语义 diff。输出候选身份、执行图、权限并集、风险等级、成功/异常测试、CapabilityGap 和人工确认事项。

## 固定边界

- 不把失败、超时、拒绝或取消路由到 `control.succeed`。
- 不给 `uncertain` 配置自动重试或自动成功出口；保留终态并要求人工核验。
- 不降低任何已发布 Node 的风险、权限、节奏或超时安全线。
- 只生成有上限、可恢复的顺序 foreach。不得生成 parallel、任意图回边、无界循环、通用 paginate、poll、补偿或子流程语法。
- 不让 Workflow 承载业务计算代码、选择器脚本、JavaScript 或页面指令。
- Catalog 缺能力时，记录 CapabilityGap，调用 `node_requirement_create`，再切换到 `$bpa-node-authoring`。页面元素预定位属于 Browser Node / Adapter 创作，不属于 Workflow。不得生成临时代码绕过 Catalog。
- AI/Codex 只能保存 Candidate，不能批准或发布；长期绑定、R2+ 动作和正式资产始终要求人工确认。
- Candidate 未通过代表性输入、每条异常边、权限审查和人工批准前，不得发布。

## 结构选择

- 单个稳定能力：`call`。
- 确定性真假路由：`decision`，只用受限条件对象。
- 有界集合：顺序 `foreach`；需要完整结果时用 `collect`，安全门禁失败时用 `stop`。
- AI 分析或人工确认/操作：`wait.assistance`，引用精确 Assistance Profile 版本。
- 明确结局：`terminal`，区分 `succeeded`、`failed`、`cancelled`、`uncertain`。

在交付前按 [review-checklist.md](references/review-checklist.md) 完成检查。
