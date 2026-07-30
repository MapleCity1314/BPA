---
title: 模块与边界
description: BPA Core、编译器、执行引擎、Runtime Provider、Gateway、Adapter 与应用层的依赖边界。
---

## 总体结构

```text
Apps
├── CLI
├── Operator Console
├── MCP Server
├── Local Core
├── Native Host
└── Extension
        │
        ▼
Control / Browser Protocol
        │
        ▼
Platform packages
├── schemas
├── compiler → workflow-ir
├── engine → node-runtime
├── assistance-core
├── dataset-core
├── evidence-core / asset-core / source models
├── persistence ports
└── gateway-core / browser-bridge
        │
        ▼
Adapters and reviewed runtime handlers
```

Apps 负责组合、I/O 和用户入口，不保存平台规则。通用包不能反向导入 App。

## 关键模块

| 模块 | 责任 |
| --- | --- |
| `schemas` | JSON Schema、生成类型和严格校验器的唯一事实来源 |
| `compiler` | 校验 Workflow、固定 Node 引用并生成 IR2 |
| `workflow-ir` | Scope、Execution Identity、结构化步骤和资产闭包 |
| `engine` | 确定性调度、暂停、恢复、重试、foreach 和状态推进 |
| `node-runtime` | Runtime Invocation/Outcome 与 Provider Registry |
| `assistance-core` | AI/人工任务、Lease、提交和自动继续边界 |
| `dataset-core` | Dataset 发布与受限记录读取 |
| `evidence-core` | Evidence 传输状态、块摘要和执行所有权 |
| `asset-core` | Blob/Asset 摘要、保留与引用约束 |
| `persistence` | Port 与原子 UoW；SQLite 是本地实现 |
| `gateway-core` | 浏览器 Session、签名、序列与协议门禁 |
| `page-model` | PageModel、ElementContract、Design Mode 生命周期和验证 |

## Engine 刻意不知道什么

Engine 不依赖 SQLite、Chrome、MCP、具体 Adapter 或业务领域。它只消费冻结的 IR2
和 Runtime Outcome。新增 Runtime 应通过 Provider Registry 注册，而不是继续扩大
Engine 内的条件分支。

## 业务逻辑放在哪里

- 平台页面定位和复杂交互只进入对应 Adapter。
- 领域匹配、证据等级和报告规则进入领域包或受信 Team Handler。
- Workflow 只组合已发布能力。
- Console 只做视图和输入，不直连数据库。
- Team Worker 不直连 Core 数据库，只通过受限调用获取输入并返回结构化结果。

这种边界让真实业务可以验证通用平台，但不会把 BPA 退化成一个不可维护的单站脚本。
