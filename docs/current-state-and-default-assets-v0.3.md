# BPA 当前实况与默认资产 v0.3

> 盘点日期：2026-07-28
> 本文记录代码实况，不把下一阶段设想写成已完成能力。

## 1. 当前结论

BPA 已从单条 Browser 冒烟链路进入可恢复的本地平台阶段，并具备一条完整的
“重点项只读检查”候选闭环：

```text
不可变包装 Dataset
→ 当前店铺
→ 完整商品范围
→ 确定性批量匹配
→ 单次歧义 Assistance
→ foreach 打开并只读检查商品
→ 问题归并
→ 确定性报告
```

当前仍是候选阶段。真实抖店页面 Design Mode、正式资产发布和真实登录态验收需要
用户在对应安全门出现时确认；代码和测试不会代替这些授权。

## 2. 已实现的平台脊柱

- Workflow v1alpha1/v1alpha2 编译为冻结 IR2，Run 保存执行计划、风险和资产闭包。
- v1alpha2 已开放 `call`、`decision`、顺序 `foreach`、`wait.assistance`、`terminal`。
- 执行身份固定为 `run + scopePath + iterationKey + stepKey + attempt`。
- Runtime 通过 Provider Registry 注册；Engine 不依赖 SQLite、Chrome、Compiler 或 MCP。
- SQLite v6 保存 Run、Checkpoint、Scope、Iteration、Inbox/Outbox、Assistance、Dataset、
  Candidate/Draft 和审计；状态推进采用 CAS 与原子 UoW。
- 取消会原子终结 IR2 Checkpoint，并向 Provider 传播；重复取消和迟到 Result 不推进状态。
- R1 AI 结果必须通过精确版本、摘要和候选范围验证；拒绝自动继续时原子升级，不会留下
  已完成 Task + 永久等待 Run。
- Dataset 导入拒绝符号链接、相对路径、非 `.xlsx`、变化中的文件和 50 MiB 以上来源；
  原始 Excel 不进入数据库。
- Team Worker 是固定 Node.js 24 独立进程，只加载安装包内白名单 Handler；它不是恶意
  代码沙箱。

## 3. 当前正式源资产

仓库包含 20 个 Node、3 个 Workflow、1 个 Doudian Adapter、2 个 Assistance Profile
和 1 个确定性验证 Policy。关键业务能力如下：

| 资产 | 作用 |
|---|---|
| `dataset.records.read@1.0.0` | 受限读取不可变 Dataset 记录页 |
| `packaging.products.normalize@1.0.0` | 合并店铺上下文与完整商品范围 |
| `packaging.master.match.batch@1.1.0` | 匹配主数据并生成完整检查队列和冻结歧义批次 |
| `doudian.shop.context.read@1.2.0` | 读取并确认当前店铺 |
| `doudian.product.scope.collect@1.0.0` | 分页、虚拟滚动、动态总数对账和位置恢复 |
| `doudian.product.editor.open@1.0.0` | 显式导航并确认商品编辑页 |
| `doudian.editor.priority-items.inspect@1.0.0` | 只读检查普通必填、SKU 与平台提醒 |
| `issues.reconcile@1.0.0` | 区分真实商品问题和 Adapter 诊断 |
| `report.issue.build@1.0.0` | 生成稳定报告、问题指纹和摘要 |
| `packaging_match_review@1.0.0` | R1 Codex 批量歧义审核 |
| `binding_confirm@1.0.0` | R2 长期绑定人工批量确认 |

`doudian.priority-items-readonly-inspect@0.3.0` 已通过 Core 级端到端 fixture：
健康但未匹配的商品仍完成打开、检查、归并和报告，结果为 0 商品问题、0 Assistance。

## 4. 浏览器与业务边界

通用扩展固定报告四项 `doudian@1.1.0` 能力和精确权限。Adapter Manifest 将 Node
版本、Handler、实现摘要、Origin 和权限绑定在一起；权限扩张会在发布前拒绝。

当前不会：

- 修改表单、选择包装、保存或发布商品。
- 绕过登录、验证码、平台风控或限流。
- 把 CSS、XPath、坐标、任意 JavaScript 放入 Workflow。
- 因包装未匹配或歧义而跳过商品基础检查。
- 把未匹配计入商品问题或问题指纹。

## 5. AI 创作实况

- Catalog v2 可按能力、平台、输入输出、风险、权限和 Adapter 版本搜索。
- Workflow Draft 使用 revision/CAS 增量编辑并保存语义 diff。
- MCP 能生成 Workflow/Node Candidate、验证、模拟和创建 CapabilityGap。
- Codex 只能创建 Candidate，不能批准或发布。
- 三套 Repo Skills 已对齐 IR2、顺序 foreach、Assistance、Dataset 和 Candidate-only
  边界。

Design Mode 的真实页面授权和多状态 ElementContract 验证尚未完成；授权前只能使用
脱敏 fixture/replay。

## 6. 工程与发布

- 整仓门禁覆盖 Schema drift、依赖边界、TypeScript strict、Unit/Contract/Integration、
  Extension MV3 build 和文档构建。
- Runtime 包不再复制源码、测试、Skills、开发依赖或用户文件；生产闭包约 16 MiB，
  包含编译应用、Schema、正式源资产、扩展、三个原生运行依赖、SBOM 和逐文件 SHA-256。
- 安装前在数据库副本上完成 Migration 与完整性检查；切换后检查 Core、Socket、
  Persistence、Native Host 文件和 Extension 文件。
- 旧 Runtime 数据库 Schema 低于当前数据时，手工回滚会失败关闭，不执行错误回滚。

## 7. 尚未完成

- 真实页面 Design Mode 授权及生成式 ElementContract 验收。
- Chrome for Testing 的完整 Native Messaging 安装包 E2E。
- 与旧插件在独立真实 Chrome Profile 的影子对比。
- 用户真实登录态下的只读验收。
- 长期绑定 DecisionRecord 的正式写入；当前确认 Task 不修改商品页面。
- `poll`、Timer、SingleNodeRun、parallel、通用 paginate、不可信代码 Sandbox。
