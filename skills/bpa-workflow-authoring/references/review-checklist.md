# Workflow 审查清单

- 输入和输出 Schema 可用代表性样例验证，未知字段策略明确。
- 每个 Node 使用已发布的精确版本。
- Workflow 风险不低于任何 Node，权限并集符合业务目标。
- 每个 Step key 在其作用域唯一；`terminal` 的成功、拒绝、失败、取消和不确定语义分离。
- foreach 有稳定 `itemKey`、`maxItems`、`maxDuration` 和明确 `onItemError`。
- 所有绑定只读取输入、已完成 Step 或当前 foreach 作用域，不引用未来输出。
- 每个 `wait.assistance` 引用精确、已发布的 Profile；R1 自动继续有确定性验证器。
- 每个外部动作都有超时、取消和结果验证。
- 重试次数有限，且只覆盖声明为可重试的错误。
- `rejected`、`cancelled`、`uncertain` 没有被误记成成功。
- `rejected` 没有重试、收集、失败路由或人工恢复出口；解除阻断后通过新 Run 重试。
- 浏览器 Node 声明精确 Origin、最小权限和稳定页面上下文。
- 高风险动作前存在人工批准；人工拒绝不会继续执行。
- 模拟覆盖成功、失败、超时、拒绝、取消和不确定结果。
- Candidate 与已发布版本的差异、风险和回退方式已解释。
- 发布仍由用户通过 CLI 明确确认。
