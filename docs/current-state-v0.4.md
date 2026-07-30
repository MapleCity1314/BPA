# BPA 0.4 当前实况

> 盘点日期：2026-07-30  
> 本文只记录已进入代码和自动测试的能力；真实平台验收仍单独列出。

## 当前结论

BPA 0.4 已完成“可信证据与业务运行中心”的基础设施纵向闭环：

```text
bpa console
→ 本地安全工作台
→ bpa.control/hello/1
→ Workflow v1alpha3 + 冻结 Browser Resource Binding
→ Browser Evidence 分块上传
→ SQLite v8 + 本地内容寻址存储
→ Source / Evidence / Asset 血缘和 Export 元数据
```

这意味着业务人员已经可以从工作台选择已发布只读 Workflow、绑定 Chrome
Session、查看 Run/Task/证据血缘，并通过独立安全通道上传文件。它仍不表示蝉妈妈、
抖音公开资产和真实抖店影子验收已经完成。

## 已完成

- `bpa console` 启动只监听 `127.0.0.1` 随机端口的临时工作台。
- 一次性 fragment token 交换 `SameSite=Strict`、`HttpOnly` Session；Host、Origin、
  CSRF、CSP 和无 CORS 边界已测试。
- CLI、Console 和 MCP 在应用请求前协商 `bpa.control/hello/1`；控制帧上限为
  512 KiB，畸形或超大连接不会终止 Core。
- Node v1alpha2、Workflow v1alpha3 和 IR2 Resource Slot 已进入 Core 正式资产入口。
- `run.create.resourceBindings` 必须精确覆盖 Workflow 资源槽位；Run、Plan、
  Checkpoint、Resource Binding Snapshot 和初始事件同一事务写入。
- Runtime 每次派发重新核对 Session ID、Capability Digest、能力集合、Origin 和认证
  等级；命令只会发送到冻结的 Session。
- Chrome/Native Host 重连会轮换 token，但复用原 Session 身份和观察状态。
- `bpa.browser/1@1.0.0` Wire Schema 未修改；已激活
  `evidence.begin → chunk → complete → ack → command.result(evidence_refs)`。
- Evidence 块固定不超过 256 KiB，支持断点续传、逐块/整体摘要、配额、Fencing 和
  Result 抢跑拒绝。
- SQLite v7 保存 Source、Blob、Asset、Evidence、Link、Staging 和 Retention；
  v8 增加 Run Resource Binding、Browser Session Observation、Export 和血缘索引。
- 大文件不经过 Control。工作台正文通过权限 `0600` 的独立 Unix Socket，使用
  一次性租约、SHA-256、MIME、大小限制和内容寻址落盘。
- 包装主数据上传后会建立 `user_file Source → restricted Asset → CAS Blob`
  血缘，再由 Core 以内存字节解析、校验并原子发布 Dataset；不接受浏览器提交的
  本地路径，Core 重启后仍可凭不可变上传回执继续导入。
- Console 已接入真实 Browser Session 列表、运行向导、任务中心、Run 时间线、
  Evidence 血缘和 Export 元数据查询。

## 当前安全边界

- 本轮仍只有 R0/R1 只读能力；不修改表单、不保存、不发布。
- Workflow 不接受 selector、XPath、坐标或任意 JavaScript。
- 带 Browser Resource Requirement 的 Node 不能通过 SingleNodeRun 猜测 Session，
  必须进入已发布 Workflow v1alpha3。
- 资源向导冻结的是操作者选择的预期单 Origin 上下文；Extension Handler 仍会在
  执行前核验真实标签页、Origin、页面上下文和权限。
- 登录、验证码、会员不可见、限流和平台风控不会被绕过。
- AI 仍只能创建 Candidate；正式资产发布必须由 CLI 人工确认。
- Console Host 不直连 SQLite，也不接收调用方指定的最终存储路径。

## 验证基线

- 整仓 `pnpm verify`：79 个测试文件、526 项测试通过。
- Schema drift、依赖边界、TypeScript strict、Extension MV3、React Console 和协议
  文档构建全部通过。
- 当前验证的生产闭包为 105 个文件、128,174,457 bytes；包含固定 Node.js 24、
  Core、CLI、Native Host、MCP、Team Worker、Extension、Console、Schema、正式
  资产、SBOM 和逐文件 SHA-256。
- Runtime 闭包与敏感内容扫描通过；`AGENTS.md`、`CLAUDE.md`、源码、测试、Skills
  和开发依赖未进入运行包。

## 仍未完成

- Chanmama 登录态指标 Adapter 和 Douyin 公开商品资产 Adapter 的正式实现。
- `browser.page.ready.observe` 的真实延迟渲染、多状态 replay 和有限刷新验收。
- 受限 Design Mode 的真实页面授权、ElementContract 候选生成和人工发布。
- 重点项检查与旧插件在独立 Chrome Profile 的影子对比。
- 预包装煎饼 frozen baseline 在新 Evidence/Asset 链路上的完整重放。
- 新真实研究任务、登录恢复、会员不可见字段和参考图精选验收。
- ReferenceAssetPack 的正文下载/归档格式；目前已完成不可变 Export 元数据和
  AssetRef 引用保护。
- Chrome for Testing 安装包 E2E、最终单一 0.4 RC 和用户真实登录态验收。

到达 Design Mode、真实 Chrome 登录或正式资产发布门时，必须再次取得用户明确授权。
