---
title: 核心概念
description: 用最少的概念理解 BPA 的资产、执行、浏览器资源和可信证据。
---

## Workflow、Node 与 Adapter

| 对象 | 回答的问题 | 不应包含 |
| --- | --- | --- |
| Workflow | 业务流程先做什么、何时分支、何时等待、何时结束 | selector、脚本、坐标、页面实现细节 |
| Node | 一步能力需要什么输入、产生什么输出、风险与权限是什么 | 动态远程代码、未声明副作用 |
| Adapter | 某个平台页面怎样定位、读取、翻页和判断就绪 | 跨平台业务编排 |

一个已发布 Workflow 只能引用已发布且版本固定的 Node。浏览器 Node 还必须由精确
Adapter 版本和 Extension Capability Manifest 提供实现。

## Candidate 与 Published Artifact

AI 和 MCP 工具可以生成 Candidate。Candidate 可以验证、模拟和比较，但不能进入
正式 Run。人工发布后形成不可变的 `asset_id + version + digest`；相同版本不能覆盖。

## Run 与 Execution Identity

Run 是一次被冻结的执行。IR2 中每次尝试的身份由以下字段决定：

```text
run + scopePath + iterationKey + stepKey + attempt
```

因此 foreach 中相同 Step 的不同条目、同一条目的不同重试不会混在一起。迟到结果和
旧 Fencing Token 不能推进当前状态。

## Resource Slot

Resource Slot 是 Workflow 对外部浏览器上下文的命名需求，例如“一个已认证的只读
页面会话”。Run 启动前，操作者把 Slot 绑定到精确 Browser Session。Slot 不是普通
输入，页面内容和 Node 输出都不能选择或替换 Session。

## Assistance Task

确定性流程遇到需要 AI 判断、人工确认或人工操作的步骤时创建 Assistance Task。
任务有独立状态、Lease 和 Fencing。AI 的 confidence 只用于排序和审计，不会扩大
权限。

## Dataset、Source、Evidence 与 Asset

- Dataset 是经过 Profile 校验和规范化的不可变记录集合。
- Source 描述信息从哪里、何时、以什么访问范围取得。
- Evidence 描述某次 Node Execution 的可验证材料。
- Asset 描述一个不可变 Blob、摘要、媒体类型、派生关系和保留策略。
- Evidence Link 把一次执行证据与 Source/Asset 连接起来，不复制正文。

这些对象分开后，同一个 Blob 可以去重，但不同来源、访问范围和业务含义不会被错误
合并。
