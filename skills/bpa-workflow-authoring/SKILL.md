---
name: bpa-workflow-authoring
description: 将已确认的真实浏览器业务过程设计、生成、校验或升级为 BPA Workflow 候选。用于梳理业务目标、输入输出、选择已发布 Node、设计成功与异常路由、设置风险和人工边界、调用 workflow_gen/workflow_validate/workflow_simulate/artifact_diff，或发现需要 node_gen 的能力缺口。不要用于直接操作浏览器、运行时临时编写代码或绕过发布审核。
---

# BPA Workflow Authoring

把业务目标沉淀为可独立运行、固定版本、可回放审查的 Workflow。只创建 Candidate；将发布交给用户通过 CLI 完成。

## 工作流

1. 明确业务产出、触发条件、输入、输出和验收证据。把“点哪里”改写为“交付什么”。
2. 用 `catalog_search` 查询已发布 Node。只使用完整 `node_id@semver`；不得猜测 Node、版本或权限。
3. 读取 [risk-and-routing.md](references/risk-and-routing.md)，确定 Workflow 风险、失败出口、人工点和 `uncertain` 处理。
4. 优先用 `workflow_gen` 创建骨架。提供具体的 `input_schema`、`output_schema`；不要接受宽泛 `{type: object}` 作为正式契约。
5. 对 Candidate 逐项补齐参数绑定、超时、有限重试、业务条件和说明。绑定只允许精确的 `${input.path}`、`${previous.path}` 或完整对象 `${input}`、`${previous}`。
6. 依次调用 `workflow_validate`、`workflow_simulate`。升级已有资产时再调用 `artifact_diff`。
7. 输出：候选身份、执行图、权限并集、风险等级、成功/异常测试、能力缺口和需要人工确认的事项。

## 固定边界

- 不把失败、超时、拒绝或取消路由到 `control.succeed`。
- 不给 `uncertain` 配置自动重试或自动成功出口；保留终态并要求人工核验。
- 不降低任何已发布 Node 的风险、权限、节奏或超时安全线。
- 不生成循环、并行、补偿或子流程语法；本地 v1 尚未启用。
- 不让 Workflow 承载业务计算代码、选择器脚本、JavaScript 或页面指令。
- Catalog 缺能力时，调用 `node_requirement_create`，再切换到 `$bpa-node-authoring`。不得生成临时代码绕过 Catalog。
- Candidate 未通过代表性输入、每条异常边、权限审查和人工批准前，不得发布。

## 默认节点用法

- `control.start`：唯一入口。
- `control.condition`：真假分支；只用受限比较 DSL。
- `control.assert`：验证不可妥协的前置条件。
- `control.noop`：透传上一步输出。
- `data.constant`：输出固定 JSON。
- `data.select`：按安全点路径取值。
- `data.merge`：浅合并对象。
- `control.human-approval`：等待当前用户明确决定。
- `control.succeed` / `control.fail`：唯一明确成功/失败终点。

在交付前按 [review-checklist.md](references/review-checklist.md) 完成检查。
