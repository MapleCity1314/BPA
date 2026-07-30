# BPA 当前实况与默认资产 v0.3

> 历史归档：已被 `docs/current/current-state-v0.4.md` 替代。

> 盘点日期：2026-07-30
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
用户在对应安全门出现时确认；代码和测试不会代替这些授权。2026-07-29 的电商
证据链真实冒烟已经验证 BPA Browser Session 可以参与多来源研究，但正式采集仍由
人工操作和外部脚本完成，不能视为 BPA 已经具备对应 Adapter。

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

仓库包含 30 个版本化 Node 源资产（26 个 Node ID）、4 个 Workflow、1 个 Doudian
Adapter、5 个 Assistance Profile 和 1 个确定性验证 Policy。关键业务能力如下：

| 资产 | 作用 |
|---|---|
| `dataset.records.read@1.0.0` | 受限读取不可变 Dataset 记录页 |
| `packaging.products.normalize@1.0.0` | 合并店铺上下文与完整商品范围 |
| `packaging.master.match.batch@1.1.0` | 匹配主数据并生成完整检查队列和冻结歧义批次 |
| `doudian.shop.context.read@1.3.0` | 读取并确认当前店铺；旧 `1.2.0` 资产保持不变 |
| `doudian.product.scope.collect@1.1.0` | 分页、虚拟滚动、动态总数对账，并冻结原始列表 URL、页码和滚动位置；旧 `1.0.0` 资产保持不变且扩展继续兼容其输出 |
| `doudian.product.scope.restore@1.0.0` | 报告生成后同源返回商品列表，复核店铺与筛选指纹并恢复原位置 |
| `doudian.product.editor.open@1.1.0` | 显式导航并确认商品编辑页；旧 `1.0.0` 资产保持不变 |
| `doudian.editor.priority-items.inspect@1.1.0` | 只读检查普通必填、SKU 与平台提醒；旧 `1.0.0` 资产保持不变 |
| `issues.reconcile@1.0.0` | 区分真实商品问题和 Adapter 诊断 |
| `report.issue.build@1.0.0` | 生成稳定报告、问题指纹和摘要 |
| `ecommerce.intent.normalize@1.0.0` | 从冻结输入规范化电商研究意图 |
| `ecommerce.category-space.build@1.0.0` | 构建功能、场景和平台类目空间 |
| `ecommerce.comparable-pool.build@1.0.0` | 构建按研究目的分层的可比商品池 |
| `ecommerce.evidence.evaluate@1.0.0` | 保留指标区间并生成 E1/E2 证据声明 |
| `ecommerce.reference-pack.build@1.0.0` | 从冻结 AssetRef 元数据构建参考包清单 |
| `packaging_match_review@1.0.0` | R1 Codex 批量歧义审核 |
| `binding_confirm@1.0.0` | R2 长期绑定人工批量确认 |
| `scope_review@1.0.0` | R2 店铺与筛选范围人工确认 |
| `auth_takeover@1.0.0` | R2 登录、验证码和风控人工接管 |
| `adapter_anomaly_review@1.0.0` | R1 页面结构异常分类，仅生成建议或 Candidate |

`doudian.priority-items-readonly-inspect@0.3.0` 已通过 Core 级端到端 fixture：
健康但未匹配的商品仍完成打开、检查、归并、报告和原列表位置恢复，结果为 0 商品问题、0 Assistance。

`ecommerce.evidence-chain-replay@1.0.0` 已通过 frozen 预包装煎饼 fixture 和 Core
级回放，能够确定性复现 5 个 Team Node 的中段决策。它不负责平台搜索、登录态
指标采集、图片下载、人工精选或正式资产归档。

## 4. 浏览器与业务边界

通用扩展固定报告五项 `doudian@1.2.0` 能力和精确权限。Adapter Manifest 将 Node
版本、Handler、实现摘要、Origin 和权限绑定在一起；权限扩张会在发布前拒绝。
恢复导航只接受当前标签页同 Origin 的 `/ffa/g/list` URL；Content Handler 会再次
校验店铺身份、筛选/页签指纹、页码和滚动位置。

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
- `bpa node-preview` 和 `bpa run-node` 已支持 R0/R1 已发布 Node 的安全单节点运行；
  R1 需要显式确认，R2+ 仍必须进入正式 Workflow。

Design Mode 的真实页面授权和多状态 ElementContract 验证尚未完成；授权前只能使用
脱敏 fixture/replay。

## 6. 工程与发布

- 整仓门禁覆盖 Schema drift、依赖边界、TypeScript strict、Unit/Contract/Integration、
  Extension MV3 build 和文档构建。
- Runtime 包不再复制源码、测试、Skills、开发依赖或用户文件。已验证的
  `v0.3.0-rc.e697e87a8370` 归档约 39 MiB，展开后的受检闭包约 127 MB，包含编译
  应用、Schema、正式源资产、扩展、固定 Node.js 24、SBOM 和逐文件 SHA-256。
- 安装前在数据库副本上完成 Migration 与完整性检查；切换后检查 Core、Socket、
  Persistence、Native Host 文件和 Extension 文件。
- 旧 Runtime 数据库 Schema 低于当前数据时，手工回滚会失败关闭，不执行错误回滚。

## 7. 尚未完成

- 真实页面 Design Mode 授权及生成式 ElementContract 验收。
- Chrome for Testing 的完整 Native Messaging 安装包 E2E。
- 与旧插件在独立真实 Chrome Profile 的影子对比。
- 用户真实登录态下的只读验收。
- 长期绑定 DecisionRecord 的正式写入；当前确认 Task 不修改商品页面。
- Browser Evidence 分块当前仍由 Core 以 `EVIDENCE_NOT_ENABLED` 拒绝，Result 中的
  Evidence ID 不会提升为可信 Runtime EvidenceRef。
- 多 Browser Session 的资源槽位、业务工作台、对象资产存储和页面稳定性契约。
- 通用 `poll`、Timer、parallel、通用 paginate、不可信代码 Sandbox。Assistance
  Deadline Timer 已实现，不等同于开放通用 Timer Step。

## 8. 2026-07-29 第二场景冒烟结论

预包装煎饼研究取得 3 个样本、15 张轮播/主图和 21 张详情切片，并生成
ReferenceAssetPack。真实运行同时暴露了八类平台缺口：

- 开发 CLI 与已安装 Core 缺少显式协议协商。
- 超大控制帧可能终止旧 Core 进程。
- 登录恢复缺少业务化提示。
- 页面资产读取缺少“页面已稳定”语义。
- 图片正文不应经过控制面。
- 登录态指标源与公开资产源需要绑定不同 Browser Session。
- 搜索命中与可比商品判断必须拆成不同节点。
- 开发命令需要在进入原生依赖前强制检查 Node.js 24。

这些问题是 BPA 0.4“可信证据与业务运行中心”的事实输入，不会通过扩大单个爬虫
Handler 来规避。
