---
title: 当前能力
description: BPA 0.4 candidate 已实现、部分完成和明确未进入的能力边界。
---

> 实现基线：2026-07-30。这里描述的是仓库与自动测试已经证明的能力，不把协议设计
> 或页面 fixture 当成真实平台验收。

## 已进入运行闭环

| 能力 | 当前状态 |
| --- | --- |
| 本地控制面 | CLI、Console 和 MCP 先进行 Control Hello，再通过本机 Socket 调用 Core |
| 执行模型 | Workflow v1alpha1/v1alpha2/v1alpha3 编译到同一 IR2；计划与资产闭包随 Run 冻结 |
| 恢复 | Run Checkpoint、Inbox/Outbox、幂等结果、Lease 与 Fencing 已持久化 |
| 浏览器 | Browser Protocol v1、Capability、签名权限、Session 恢复和精确资源绑定 |
| 可信证据 | Evidence 分块、断点恢复、整体摘要、Result 引用门禁和 Evidence Link |
| 本地资产 | SHA-256 内容寻址 Blob、Source/Asset 元数据、保留策略和引用保护 |
| Dataset | 安全上传、格式校验、规范化记录、不可覆盖发布和分页读取 |
| 人工协作 | AI Review、Human Confirm、Human Action 的任务、认领、Lease 与提交 |
| 业务入口 | 只监听本机的 Operator Console、运行向导、任务中心、时间线和血缘视图 |

当前仓库门禁报告 30 个 Node、4 个 Workflow、1 个 Adapter、5 个 Assistance
Profile 和 3 个创作 Skill。整仓基线为 80 个测试文件、527 项测试通过。这些数字
是当前构建快照，不是公共 API 承诺。

## 已有基础，但仍需真实验收

- 页面 Readiness Contract 已定义并有解析测试，复杂延迟渲染、稳定采样和有限刷新
  仍需真实页面 replay。
- 多 Browser Session 和认证等级已能冻结、恢复和派发前复核，登录失效后的完整业务
  接管仍需真实登录环境验收。
- Evidence、Source、Asset 与 Export 元数据已经连通；完整参考资产包正文格式和下载
  通道仍在后续迭代。
- Operator Console 已覆盖日常入口，但真实业务的长流程、浏览器安装包 E2E 和影子
  对比尚未完成。

## 明确没有进入当前版本

- 浏览器表单修改、保存、发布等 R2+ 写动作。
- 验证码自动处理、会员权限规避、限流或风控绕过。
- 任意并行、通用回边循环和未受信代码沙箱。
- PostgreSQL、远程 Gateway、多人协作和云对象存储。
- 完整可视化 Workflow Studio。

## 如何判断一句能力描述是否可信

优先级从高到低：

1. 真实登录环境的只读验收和审计记录。
2. Chrome for Testing 或完整安装包 E2E。
3. 跨进程集成测试与崩溃恢复测试。
4. fixture/replay。
5. 单元测试。
6. 仅有 Schema、ADR 或计划。

文档中的“已实现”至少要求进入自动测试；“真实可用”还要求对应业务验收。

日常操作从[使用本地工作台](../../guides/operator-console/)开始；需要判断文档是否
代表当前事实时，可以读取[机器可读文档](../../reference/machine-readable/)中的
权威等级和实现状态。
