# BPA 0.6 跨平台与低负担工作台当前实况

## 当前结论

截至当前提交，Windows x64 已进入可验证 RC 候选阶段，而不是宣称完成真实业务
验收。macOS arm64 现有运行路径保持兼容。

公司业务部署已另行决定采用 Mac 唯一执行、Windows 远程查看/受控请求。Windows x64
Runtime 继续作为 P2 可选服务器能力验证，不再代表公司清退等业务应在 Windows 执行。

已实现：

- `@bpa/platform-runtime` 统一 macOS/Windows 数据路径与 IPC 端点。
- macOS 继续使用权限受控的 Unix Domain Socket。
- Windows 使用按安装根目录隔离的 Named Pipe。
- Control、Staging、Native Host 和 Core 使用同一端点解析规则。
- Windows 当前用户安装、升级演练、SQLite 备份、Migration、健康检查、卸载与
  运行时指针回滚脚本。
- Windows Chrome Native Messaging Host 使用独立 SEA 可执行文件，并注册在
  当前用户 HKCU。
- Windows x64 生产闭包包含 Node.js 24 与对应的 `better-sqlite3` 原生模块。
- GitHub Actions 增加 Windows 类型、测试、构建、原生模块加载、Migration 和
  RC 归档验证。
- `attention-core`、`interaction-policy` 和 `operator-read-model` 首批纯领域
  实现。
- 工作台默认导航收敛为首页、任务、结果、自动化；诊断与创作迁入高级入口。
- 首页健康状态保持安静，优先展示新任务、待处理、运行和结果。
- 工作台增加明暗主题和 Reduced Motion。

仍未完成：

- Windows 真机安装后的 Chrome 手工加载扩展和真实页面只读验收。
- Windows 安装包签名、SmartScreen 声誉、MSIX 或企业策略分发。
- Extension 一键页面授权；当前受治理的复制绑定流程仍作为兼容路径。
- AttentionItem 尚未持久化为新的正式 Schema，也没有替代 AssistanceTask。
- 任务历史列表和最近业务结果仍受现有 Control 查询能力限制。
- 重点项检查和蝉妈妈流程的非技术运营人员可用性测试。
- 远程 HTTPS 身份、Viewer/Operator RBAC 与 allowlist Trigger 调用；当前 Console
  Viewer 仍是 loopback 本地边界，不能据此宣称 Windows 已可远程访问。

## 发布判定

只有同时满足以下条件，Windows 才能从 `partial` 调整为 `active`：

1. Windows CI 生成的同一 RC 归档通过原生 Node、SQLite、Migration 与安装健康
   检查。
2. Windows 11 x64 当前用户安装和卸载保留数据行为通过。
3. Chrome 能通过 HKCU Native Host 注册连接固定 BPA Extension。
4. 至少一条真实只读 Workflow 在 Windows 上成功并可恢复。

在此之前，公开文档必须使用“Windows RC 候选”而不是“Windows 已正式支持”。
