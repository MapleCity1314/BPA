# 快速创作与能力缺口

## 三遍完成草稿

### 第一遍：业务骨架

先形成简短的 ScenarioSpec：

- 目标和成功证据。
- 输入、输出和触发方式。
- 页面、账号、店铺或数据范围。
- 最高允许风险。
- 人工、等待、批量和循环需求。

此时不要写 Node 名、选择器或页面操作。

### 第二遍：语义能力

1. 先搜索已有 Workflow、Recipe 和相近业务场景。
2. 再用 Catalog 搜索动词、对象、平台、输入输出和风险。
3. 固定每个 `node_id@semver`，补齐绑定和异常出口。
4. 找不到能力时记录 CapabilityGap。

不要为凑齐流程猜测 Node，也不要把 CSS、XPath、坐标、JavaScript 或页面文案
放入 Workflow。浏览器能力缺失时切换到 `$bpa-node-authoring`。

### 第三遍：验证和收口

1. 校验 Schema、版本、权限和所有路由。
2. 模拟成功、业务失败、超时、取消、人工拒绝和 `uncertain`。
3. 检查输出 Schema 能否表达部分成功和人工修正。
4. 输出执行图、CapabilityGap、风险和人工确认项。

复杂流程必须采用增量草稿：一次只增加或配置一个 Step、绑定、Test 或异常策略，
每次携带 `expectedRevision`。CAS 冲突时读取最新草稿并做语义合并，不能覆盖他人
修改。完成后校验草稿并保存不可变 Candidate。

## 常见模式

- 单节点临时调用：先 `bpa node-preview`，再用 `bpa run-node` 执行 Core 生成的有界包装器；不要创建一次性 Workflow Candidate。只允许已发布 R0/R1 Node，R1 要明确确认，R2+ 回到正式 Workflow。
- 需要协助：选择 `ai_review`、`human_confirm` 或 `human_action`，不统一写成批准。
- 等待外部变化：当前不要生成 `poll` 或长 sleep；记录 CapabilityGap，等待持久化 Timer/Poll 能力正式开放。
- 集合处理：使用顺序 foreach，设置稳定 `itemKey`、上限、总时限和错误聚合策略。
- 页面定位缺失：创建 NodeRequirement 和 ElementContract 候选，不污染 Workflow。

## v1alpha2 绑定

```text
${input.dataset}
${steps.shop_context.output.shop.id}
${steps.collect_products.output.products}
${item.id}
```

只允许从输入、已完成 Step 输出和当前 foreach item 读取。当前不要使用 `${index}`；
它不允许参与稳定执行身份或普通绑定。不要使用
`${previous}`、CSS、XPath、坐标、函数、模板表达式或 JavaScript。
