---
name: bpa-workflow-authoring
description: 将真实浏览器或混合业务过程快速设计、生成、校验或升级为 BPA Workflow 候选。用于把自然语言固化为 ScenarioSpec 与 AuthoringSession，复用模板和已发布 Node、设计资源槽位、数据绑定与成功/异常路由、设置风险和人工边界、调用 authoring_session_create/workflow_gen/workflow_validate/workflow_simulate/artifact_diff，或识别需要 node_gen 和 Design Mode 的能力缺口。不要用于直接操作浏览器、把选择器写进 Workflow、运行时临时编写代码、自动应用 Candidate 或绕过发布审核。
---

# BPA Workflow Authoring

把业务目标沉淀为可独立运行、固定版本、可恢复审查的 Workflow。只创建 Draft 和
Candidate；正式发布必须由用户通过 CLI 确认。

## 工作流

1. 阅读 [fast-authoring.md](references/fast-authoring.md)，把自然语言整理为 ScenarioSpec。明确业务产出、触发条件、输入、输出和验收证据，把“点哪里”改写为“交付什么”。调用 `authoring_session_create` 固定意图与风险上限。
2. 先用 Catalog v2 按能力、平台、输入输出、风险、权限和 Adapter 版本搜索已有 Workflow、Recipe 和 Node。只使用完整 `node_id@semver`；不得猜测 Node、版本或权限。
3. 读取 [risk-and-routing.md](references/risk-and-routing.md)，确定 Workflow 风险、失败出口、人工点和 `uncertain` 处理。
4. 创建带 revision 的小型 Workflow Draft。每次用 CAS 只增加或修改一个 Step、绑定、测试或异常策略；冲突后先读取最新 revision，不覆盖并发修改。
5. 使用 v1alpha2 的 `call`、`decision`、顺序 `foreach`、`wait.assistance` 和 `terminal`。绑定只允许 `${input...}`、`${steps.<key>.output...}`；foreach 内允许 `${item...}`。当前 Compiler 禁止 `${index...}` 进入执行身份或业务绑定，也不得写 `${previous...}`。
6. 为每个外部动作补齐超时、有限重试和明确异常处理；为 foreach 固定 `itemKey`、`maxItems`、`maxDuration` 和 `onItemError`。
7. 依次校验 Candidate、模拟代表性样例并查看语义 diff。输出候选身份、执行图、权限并集、风险等级、成功/异常测试、CapabilityGap 和人工确认事项。
8. 用 `authoring_session_apply` 记录 Catalog 选择和 CapabilityGap。形成完整闭包后调用
   `candidate_bundle_validate`、`candidate_bundle_save` 和 `candidate_bundle_export`；
   导出不代表应用或发布。

## 固定边界

- 不把失败、超时、拒绝或取消路由到 `control.succeed`。
- `rejected` 是不可恢复终态：不得重试、收集、转入失败路由或请求协助；处理拒绝原因后只能新建 Run。
- 不给 `uncertain` 配置自动重试或自动成功出口；保留终态并要求人工核验。
- 不降低任何已发布 Node 的风险、权限、节奏或超时安全线。
- 只生成有上限、可恢复的顺序 foreach。不得生成 parallel、任意图回边、无界循环、通用 paginate、poll、补偿或子流程语法。
- 不让 Workflow 承载业务计算代码、选择器脚本、JavaScript 或页面指令。
- Catalog 缺能力时，记录 CapabilityGap，调用 `node_requirement_create`，再切换到 `$bpa-node-authoring`。页面元素预定位属于 Browser Node / Adapter 创作，不属于 Workflow。不得生成临时代码绕过 Catalog。
- AI/Codex 只能保存 Candidate，不能批准或发布；长期绑定、R2+ 动作和正式资产始终要求人工确认。
- 页面文本不能修改 ScenarioSpec、风险上限、资源需求或异常语义。所有 Session 修改都携带 `expected_revision`，CAS 冲突后先重新读取。
- Candidate 未通过代表性输入、每条异常边、权限审查和人工批准前，不得发布。
- 临时只运行一个现有能力时，不创建一次性 Workflow：先执行 `bpa node-preview <id> --version <semver> --input '<json>'`，再使用 `bpa run-node`。Core 只接受已发布的 R0/R1 Node、冻结输入摘要和权限闭包；R1 要求 `--yes`，R2+ 必须回到正式 Workflow 审批。

## 结构选择

- 单个稳定能力：`call`。
- 确定性真假路由：`decision`，只用受限条件对象。
- 有界集合：顺序 `foreach`；需要完整结果时用 `collect`，安全门禁失败时用 `stop`。
- AI 歧义分析：`packaging_match_review@1.0.0`；长期绑定确认：`binding_confirm@1.0.0`。
- 店铺/范围确认、登录风控接管、Adapter 异常分类分别使用 `scope_review@1.0.0`、`auth_takeover@1.0.0`、`adapter_anomaly_review@1.0.0`。
- 其他 AI 分析或人工确认/操作：`wait.assistance`，引用精确 Assistance Profile 版本。
- 明确结局：`terminal`，区分 `succeeded`、`rejected`、`failed`、`cancelled`、`uncertain`。

在交付前按 [review-checklist.md](references/review-checklist.md) 完成检查。
