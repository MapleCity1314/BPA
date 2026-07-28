# BPA 强化迭代协议候选 v0.4

状态：等待人工确认

日期：2026-07-28

## 1. 本次冻结范围

本次只冻结后续并行实现共同依赖的平台脊柱：

- Workflow v1alpha2 的结构化创作模型。
- Workflow IR2、执行身份、计划快照和资产闭包。
- AssistanceTask 的状态、Lease 和自动继续边界。
- DatasetVersion、DatasetRef 和 DecisionRecord。
- PageModel / ElementContract 与 Adapter 的发布关系。
- Task 创建/提交与 Run 暂停/唤醒的原子边界。

`bpa.browser/1` 保持不变。PageModel 不通过普通 Workflow input 动态下发，
而是在发布时编译进精确 Adapter 版本和 Extension capability manifest。

## 2. Workflow v1alpha2

Workflow v1alpha2 使用嵌套的结构化块，不允许任意跳转：

```text
sequence
├── call
├── decision
├── foreach
├── wait.assistance
└── terminal
```

绑定只允许以下根：

- `${input...}`
- `${steps.<step-key>.output...}`
- `${item...}`
- `${index}`

`decision` 不接收表达式字符串，而使用 `compare`、`all`、`any`、`not`
组成的结构化条件树。比较两侧只能是显式 binding 或 JSON literal，不能传入
JavaScript、模板代码或动态求值表达式。

`with` 和 `terminal.output` 是受限 JSON。Schema 先拒绝 selector、XPath、
坐标和脚本类保留键；Compiler 还必须结合目标 Node 的 input Schema 和权限
声明校验。Workflow 无法借普通参数绕过 Adapter 边界。

Step key 在当前作用域内唯一。`foreach` 的 `itemKey` 必须在冻结的输入集合中
唯一且稳定。数组下标不能单独作为长期身份。

`foreach`：

- 顺序执行。
- 最多 500 项。
- 必须声明总时限。
- `stop` 在第一项失败时停止。
- `collect` 记录该项错误并继续；`uncertain` 始终停止，不允许收集后继续。
- 输出包含有序的 succeeded、failed、unresolved 项及摘要。

`wait.assistance`：

- `blocking=true` 时创建 Task 与暂停 Run 必须是同一事务。
- `blocking=false` 只创建后续任务，不改变 Run 的执行游标。
- Provider 不可用时只能使用已发布 Profile 中固定的
  `continue_unresolved`、`human_action` 或 `fail`。
- 非阻塞 Task 创建后沿 `next` 立即继续；它后续完成只能写 Task、Event 和
  Audit，不能倒推或重新推进已经前行的 Run。

## 3. IR2 与恢复

Compiler 将 v1alpha1 和 v1alpha2 都编译为 IR2。创建 Run 时固化：

- IR2 canonical JSON 和 digest。
- Workflow source digest。
- 风险快照。
- 所有 Node、Adapter 和 Policy 的精确版本与摘要。

IR 标识固定为 `bpa.workflow-ir/2`。每个 `call` 固化 timeout、retry、timing、
Runtime Provider、权限快照引用以及各类终态路由；每个 `foreach` 固化
`maxItems`、`maxDuration`、`onItemError` 和聚合语义；每个
`wait.assistance` 固化 blocking、deadline 和 provider-unavailable 策略。

Engine 恢复时不重新选择资产。Step attempt 身份为：

```text
run_id + scope_path + iteration_key + step_key + attempt
```

相同结果重复到达只能得到同一幂等结果；旧 iteration 或旧 fencing token
不能推进当前执行。

## 4. AssistanceTask

首批模式：

- `ai_review`：Codex 输出严格结构化建议。
- `human_confirm`：人确认、修正或拒绝长期决定。
- `human_action`：登录、验证码、切店或页面恢复。

状态：

```text
queued → claimed → processing → completed
                         └─────→ awaiting_human → completed

queued / claimed / processing → expired | cancelled | failed
```

Claim 使用可续租 Lease 和递增 fencing token。Lease 过期后可被重新认领；旧
owner 的提交必须拒绝。

`processing` 只能由当前 Lease owner 从 `claimed` 进入。AI 结果需要人复核时
进入 `awaiting_human`，并发放新的递增 fencing token；任何 terminal 状态都
不能再次认领或提交。

AI 是否自动推进由发布策略决定：

- R0 Profile 可选择自动推进。
- R1 还需要白名单和确定性结果验证器。
- R2+、durable decision 和未来写授权必须人工确认。
- confidence 不提供权限。

这里的“可选择”由发布 Profile 产生的 `policySnapshot.autoContinue` 明确
记录；没有该快照或快照为 false 时，即使是 R0 也不能自动推进。

## 5. Dataset 与 Decision

Dataset 导入流程：

```text
source file
→ staging
→ digest / profile / schema validation
→ normalized records
→ atomic DatasetVersion publish
```

相同 Dataset ID + version 不可覆盖。Run 只保存 DatasetRef，Worker 通过受限、
分页的 Dataset Query Port 读取，不接收任意本地路径。

DecisionRecord 可撤销或被新记录替代。复用必须精确匹配记录声明的 scope 和
precondition digests。包装绑定至少包含店铺、商品、规范化标题、目标记录、
matcher 和 rule 版本；Excel 中无关记录改变不会导致绑定失效。

未经过人工确认的对象称为 `DecisionCandidate`，不是 DecisionRecord。只有
确认后才创建 `active` DecisionRecord；被替代或撤销后分别进入
`superseded`、`revoked`，两者都不可复用。

## 6. PageModel 与 Adapter

Design Mode 只创建 Candidate。ElementContract 至少需要两个脱敏页面快照，
且至少一个非 CSS 的稳定策略。XPath、屏幕坐标、任意脚本和 CSS-only 合同拒绝。

简单只读字段可以生成受限声明式 Reader；分页、虚拟滚动、导航恢复和未来写入
必须实现为审核 Adapter Handler。发布 PageModel 会产生新的 Adapter/Node
版本，不能覆盖运行中的版本。

## 7. 兼容性

- 现有 Workflow/Node v1alpha1 不需要重新发布。
- v1alpha1 编译为单层 IR2，并保持现有成功、失败、重试和人工审批行为。
- 已经处于等待浏览器/人工状态的旧 Run，在第一次恢复前固化 IR2。
- Browser Protocol v1、Permission v1、Event v1 和 Evidence v1 不变。
- 首批继续拒绝 parallel、通用 paginate、任意循环回边和不可信代码。

## 8. 实现门

确认本候选后，后续模块只允许实现这些语义。任何需要改变执行身份、自动推进
边界、PageModel 发布方式或 Browser Protocol 的需求，必须形成新的 ADR 和协议
版本，不能在实现中静默扩展。
