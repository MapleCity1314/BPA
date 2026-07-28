# BPA 当前实况与默认资产 v0.3

> 盘点日期：2026-07-28
> 范围：本地 Core、Compiler、Engine、MCP 创作工具、默认 Node 和 Repo Skills

## 1. 盘点结论

0.2.1 已经具备真实 Chrome + 抖店只读纵向闭环，但“架构设计中的能力”和“代码实际启用的能力”仍有明显距离：

- 仓库只有 5 个 Node 资产；Engine 实际只执行 `control.start`、`control.succeed`、`control.condition`，另有人工暂停和一个 Doudian Browser Node。
- 方案中列出的 `control.fail` 尚未实现，生成器把失败路由到成功终点，可能掩盖异常语义。
- Compiler 能检查引用和可达性，但没有拒绝循环、风险降级、禁用 Runtime、未知 Builtin 或终端节点出边。
- Engine 没有执行 Workflow 输入、Node 输入、Node 输出和 Workflow 输出的 JSON Schema 契约。
- `with` 参数没有正式绑定语义；示例中的节点输出引用事实上依靠 `control.succeed` 隐式透传。
- `workflow_gen`、`node_gen` 已能创建 Candidate，但风险推导、能力缺口、权限报告、异常路由和模拟输出仍较粗。
- 架构文档描述了 Workflow/Node Skill，仓库此前没有可被 Codex 发现和复用的正式 Repo Skill。

因此，0.3 的重点不是增加更多页面写动作，而是先补齐“默认组合能力 + 契约执行 + 生成治理”。

## 2. 0.3 默认资产

| Node | Runtime | 作用 |
|---|---|---|
| `control.start@1.1.0` | Core | 唯一入口，输出已验证的 Workflow 输入 |
| `control.succeed@1.1.0` | Core | 明确成功终点 |
| `control.fail@1.0.0` | Core | 明确失败终点；系统错误固定，业务原因单独保存 |
| `control.noop@1.0.0` | Core | 透传上一步或显式 value |
| `control.condition@1.1.0` | Core | 受限真假分支 |
| `control.assert@1.0.0` | Core | 前置条件不满足时失败 |
| `control.human-approval@1.1.0` | Human | 等待当前用户批准或拒绝 |
| `data.constant@1.0.0` | Core | 输出固定 JSON |
| `data.select@1.0.0` | Core | 按安全点路径选择字段 |
| `data.merge@1.0.0` | Core | 安全浅合并对象 |
| `doudian.shop.context.read@1.2.0` | Browser | 读取真实抖店店铺上下文 |

仍未启用：

- `switch`、`wait`、循环、并行、补偿和子流程。
- `composite` 与 `engine_team` Runtime。
- 通用零适配的 click/input/select Browser Node。
- 未经人工批准的页面写入。

Compiler 会在发布前拒绝这些尚未实现的能力，不再把错误推迟到运行时。

## 3. 契约执行链

```text
Workflow Schema
  → Workflow input validation
  → safe input/previous binding
  → Node input validation
  → Builtin / Browser / Human execution
  → Node output validation
  → transition and risk handling
  → Workflow output validation
  → terminal Run
```

参数绑定只允许精确引用：

```text
${input}
${input.shop_id}
${previous}
${previous.shop.id}
```

不支持字符串内插、函数、算术、JSONPath、JavaScript 或 `nodes.*` 历史访问。需要保存多个结果时，应使用明确的数据节点或后续受审查的状态模型。

## 4. Compiler 新约束

- Workflow 风险不得低于任一引用 Node。
- 本地未启用的 Runtime 在编译期拒绝。
- `engine_builtin` 必须在 Core 支持清单中。
- `control.start` 只能作为 `spec.start`。
- `control.succeed` 和 `control.fail` 不得声明出边。
- `control.condition` 和 `control.assert` 必须声明受限条件。
- 图中存在循环时拒绝；本地 v1 不用递归执行模拟循环。
- Workflow 与 Node 的嵌入 JSON Schema 必须是合法且可编译的 Schema。
- Browser 成功 Result 不符合输出契约时转换为不可重试的 `OUTPUT_SCHEMA_INVALID`。

## 5. 创作工具与 Skills

`workflow_gen` 现在先读取 Published Catalog，再：

- 检查精确 Node 版本和默认控制节点。
- 推导不低于 Node 的 Workflow 风险。
- 汇总权限。
- 把 failure/timeout/rejected/cancelled 路由到明确失败终点。
- 保留 `uncertain` 为人工核验终态。
- 在保存 Candidate 前调用正式 Compiler。

`node_gen` 现在：

- 保护 `control.*`、`data.*` 命名空间。
- 要求 Browser Node 使用精确 Origin。
- 根据权限推导最低风险并拒绝降级。
- 区分 composite、browser、engine_team 和 human 实现边界。
- 输出契约测试清单；仍不能发布。

Repo 新增三项 Skill：

- `bpa-workflow-authoring`
- `bpa-node-authoring`
- `bpa-runtime-diagnostics`

Skill 只教授方法和停止边界；正式资产操作仍通过 MCP/CLI，运行时不读取 Skill。

## 6. 本轮真实验收

- BPA Runtime `0.3.0` 已用捆绑 Node.js 24 在 macOS arm64 完成安装和 Migration。
- 11 个默认 Node、`core.data-flow-smoke@1.0.0` 和
  `doudian.shop-context-observe@1.2.0` 已经 CLI 校验、发布并生成审计。
- Core 数据流真实运行通过，安全字段选择和合并得到带 `verified: true` 的终态输出。
- Chrome 扩展报告 3 个 Doudian Node 版本能力；真实抖店 1.2 Workflow
  通过严格 Node/Workflow 输出 Schema 并成功终结。
- 扩展升级路径改为 `~/Library/Application Support/BPA/extension` 物理稳定目录。
  安装失败会恢复旧目录；以后版本切换后只需在 Chrome 重新加载。
- Gateway 实验 5 项、BPA 58 项、原重点项插件 51 项和原插件 E2E 2 项均通过。

## 7. 下一步建议

1. 为 `control.wait` 设计持久化 Timer Inbox/Outbox，避免 Core 内阻塞等待。
2. 增加只读通用 Browser observe/assert 节点，再迁移重点项检查的扫描阶段。
3. 为多结果引用设计显式 Run State，而不是扩大字符串模板能力。
4. 完成 Evidence 分块传输后再开放写前/写后证据。
5. 在隔离 Worker 和签名分发完成前继续禁用 `engine_team`。
