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

复杂流程应采用增量草稿：一次只增加或配置一个 Node/Edge/Test，并保留 revision
和局部 diff。当前工具不支持增量操作时，用小型可验证片段组合，最后再生成完整
Candidate。

## 常见模式

- 单节点临时调用：建议运行时生成受审计的 SingleNodeRun，不降低权限。
- 需要人处理：选择 approval、input、action、review 或 takeover，不统一写成批准。
- 等待外部变化：使用持久化 wait/poll，不使用长 sleep。
- 集合处理：使用未来的结构化 foreach，不创建图回边。
- 页面定位缺失：创建 NodeRequirement 和 ElementContract 候选，不污染 Workflow。
