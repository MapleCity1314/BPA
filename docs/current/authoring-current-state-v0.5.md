# BPA 0.5 AI 创作当前实况

> 文档类别：当前实况。记录 `codex/bpa-05-authoring` 已进入代码的能力与仍需真实页面
> 授权的验收门，不把候选实现描述为已发布业务资产。

> 盘点日期：2026-07-30

## 已进入代码

- `bpa.authoring/v1alpha1` 的 ScenarioSpec、AuthoringSession、PageSnapshot 和
  CandidateBundle Schema 已确认并生成类型。
- SQLite v9 保存 Scenario、CAS revision、Design Mode Grant、PageSnapshot、
  Candidate Bundle、验证结果和导出 Audit；Migration append-only。
- Design Mode 绑定精确 Browser Session、Profile、Tab、HTTPS Origin、PageEpoch 和
  15 分钟 TTL。Console 负责人工授权，MCP 只能核验、捕获和停止。
- 通用扩展可捕获最多 5,000 个、单字段最多 160 字符、正文最多 5 MiB 的脱敏语义
  快照；密码、隐藏输入、Cookie、Token、手机号和邮箱不会作为正文上传。
- Core 重新读取 CAS Evidence，校验 Blob SHA-256、Result 一致性、Origin、
  PageEpoch、整体内容摘要和每个语义节点摘要后，才允许附加 PageSnapshot。
- MCP 已提供 Authoring Session、Design capture/query、Page Candidate 和 Candidate
  Bundle 的创建、校验、保存与导出工具。Snapshot query 每次最多返回 200 个节点。
- PageModel/ElementContract Candidate 要求至少两个快照、至少一个稳定非 CSS 定位，
  并在所有快照上满足数量约束。
- 简单文本、存在性和安全属性读取已有确定性声明式 replay；相对锚点、分页、虚拟
  滚动和恢复继续要求审核 Adapter Handler。
- `page_candidate_gen` 只保存 Registry Candidate，并把 PageModel、Contract 和实现
  计划写入本地 CAS，不应用源码。
- Candidate Bundle 保存前校验 Scenario、Session revision、R0/R1 上限、Registry
  依赖闭包和 CAS 文件元数据。导出为确定性 tar，包含 manifest、候选文件、patch、
  风险/验证报告和逐文件 SHA-256。
- CLI 已提供 `bpa candidate inspect|export|verify`。导出不会执行代码、修改仓库或
  发布资产。
- 抖店标准答案回归使用既有 105→106 商品范围 replay，验证声明式读取与审核
  Adapter 的总数结果一致，且没有扩大 Origin 或权限。

## 仍需真实页面或人工门

- 蝉妈妈商品搜索、详情和指标读取需要用户在已登录页面对两个代表性状态分别授权
  Design Mode；当前不会猜测页面结构。
- 真实 PageSnapshot 形成后，Codex 仍需生成蝉妈妈 Candidate，完成 replay、会员
  不可见字段和时间窗口校验。
- Candidate tar 只能供人工审查。应用 patch、正式资产发布和真实只读 Workflow
  验收尚未发生。
- 截图逐次授权、复杂 Handler 实现和 Chrome 真实页面稳定性仍需单独验收。
- BPA Runtime 当前版本仍为 `0.4.0`；完成真实页面验收前不标记 `0.5.0` 正式发布。

## 当前安全结论

这条创作链已经能在不信任页面文本、不让模型碰源码目录、不自动执行生成代码的前提
下形成可验证候选。它还不是“输入一句话即可自动上线”的页面录制器，也不允许写表单、
保存、发布、绕过登录、验证码、会员或平台风控。
