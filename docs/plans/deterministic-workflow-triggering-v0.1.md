# BPA 确定性触发与自动运行设计 v0.1

> 文档类别：平台能力计划。
> 记录时间：2026-08-05。
> 实现状态：Manual、Schedule、Dataset 最小平台内核已实现；Domain Event、External Event 和可视化运行日历待后续版本。

## 1. 目标

BPA 应像成熟 RPA 平台一样，在工作流发布和配置后，不依赖 AI 即可按计划或业务事件持续执行。AI 可以帮助创建、诊断和解释，但不能成为生产运行依赖。

关联决策：[ADR 0008](../adr/0008-app-supervision-data-pipeline-browser-runtime-boundary.md)。

## 2. 当前能力与缺口

### 已经具备

- CLI 可以直接执行已发布 Workflow。
- Core 可以按固定 Node、Adapter、Workflow 和资源版本确定性执行。
- App 可以使用 launchd 或自己的 Scheduler 周期触发。
- App 已有 PostgreSQL 租约、fencing token 和幂等运行标识。
- 库存多店铺任务可以由 launchd 启动，不需要 AI 发起正常周期。

### 尚未平台化

- 通用 TriggerSpec 和统一管理 API。
- 定时、数据到达、领域事件和人工触发的统一状态机。
- 可视化启停、运行日历、错过周期与补偿策略。
- Trigger、Workflow Run 和 Dataset 的统一血缘。
- 面向全部 App 的租约、熔断、重试和 SLO 展示。

结论是：**BPA 已经可以无 AI 执行，但无 AI 自动触发尚未完整产品化为平台通用能力。**

## 3. Trigger 不是普通 Node

定时器和外部事件发生在工作流开始之前，不能设计成普通 Node，否则会形成“先运行工作流才能触发工作流”的循环。

```text
TriggerSpec
→ 创建 Workflow Run
→ Runtime 执行 Nodes
→ 发布 Versioned Facts
→ 产生 Domain Events
→ 独立 Delivery
```

| 层级 | 职责 |
| --- | --- |
| Trigger | 决定何时创建 Run、固定 Workflow 版本、输入和幂等键 |
| Runtime | 租约、fencing、恢复、资源绑定和执行终态 |
| Node | 执行工作流内部的确定性业务步骤 |
| App | 选择触发条件、组合 Workflow 和定义领域策略 |

## 4. Trigger 类型

| 类型 | 示例 | 关键约束 |
| --- | --- | --- |
| Manual | 员工点击立即运行 | 权限和幂等键 |
| Schedule | 每 30 分钟采集库存 | 时区、错过周期和防重叠 |
| Dataset | 新订单数据集发布后预测 | 固定数据集版本和去重 |
| Domain Event | 风险事件进入待通知 | 事件唯一键和状态机 |
| External Event | 受信 webhook 或消息 | 签名、Schema、限流和重放保护 |
| Recovery | 数据过期且没有任务运行 | 组合检查进程和有效租约 |

浏览器 DOM 变化、页面文本和模型输出不得直接成为无边界 Trigger，必须先转换为经过验证的领域事实或事件。

## 5. TriggerSpec 建议

```ts
interface TriggerSpec {
  readonly id: string;
  readonly version: string;
  readonly appId: string;
  readonly kind: "manual" | "schedule" | "dataset" | "domain_event" | "external_event" | "recovery";
  readonly workflow: { readonly id: string; readonly version: string };
  readonly enabled: boolean;
  readonly inputSchemaVersion: string;
  readonly concurrencyKey: string;
  readonly idempotencyPolicy: string;
  readonly retryPolicy: string;
  readonly missedRunPolicy?: "skip" | "run_once" | "bounded_catch_up";
}
```

TriggerSpec 固定工作流版本和权限边界。修改 Trigger、Workflow 版本、外部写入能力或通知目的地必须形成配置审计。

## 6. 运行状态机

```text
enabled
→ due
→ lease_acquired
→ run_created
→ running
→ complete | partial | blocked | degraded | failed | skipped
```

- `skipped`：已有有效运行或策略明确跳过。
- `blocked`：登录、验证码、权限、店铺或风险边界阻断。
- `partial`：存在有效输出，但范围不完整。
- `degraded`：使用合格旧事实或回退路径继续处理。
- `failed`：未达到最低可用结果，且不属于安全阻断。

状态文件、日志和前端标签只是视图。下一次触发必须根据有效租约、受管进程和持久化运行记录判断。

## 7. AI 边界

### 生产路径不依赖 AI

- 周期与事件触发。
- 幂等键、租约和 fencing。
- 数据同步、转换和持久化。
- 固定模型和风险状态机执行。
- 已批准模板的通知投递。

### AI 可以参与

- Workflow 和 Node 开发。
- 生产故障分类与中文解释。
- 诊断包归纳和修复建议。
- 人工评审辅助。
- 严格条件满足时的监督性 kickstart。

AI 不能绕开 Runtime 租约、权限和效果确认，也不能成为内部脚本的隐藏调度入口。

## 8. 通用能力归属

| 能力 | 应归属 |
| --- | --- |
| 定时和事件触发 | Trigger Runtime，不是普通 Node |
| 租约、fencing、幂等 | Core / App Runtime |
| Page Binding 和 Control Lease | Browser Runtime |
| 订单、库存等平台读取 | Adapter Node |
| Dataset 读取和事实发布 | 通用服务 Node |
| 预测和风险计算 | 纯计算 Node |
| Domain Event 持久化 | 通用服务 Node |
| 飞书、钉钉、邮件 | Delivery Adapter / Effect Node |
| 中文故障解释 | 可选 AI Assistance |

## 9. 安全约束

- Trigger 只能引用已经人工发布的 Workflow 版本。
- 自动运行不能扩大 Node manifest 权限。
- 页面内容不能修改 Trigger 配置。
- 外部写入使用独立效果策略、幂等键和审计。
- 登录、验证码、风控、未知弹窗和店铺不匹配继续安全停止。
- 不确定外部写入不得自动重试。
- Recovery Trigger 不得形成第二控制面。

## 10. 实施顺序

### P0：固化现有 App 调度

- 每个 App 明确唯一调度入口。
- 清理 Codex、launchd 和内部脚本的重复触发路径。
- 统一运行终态和组合事实判定。

### P1：平台化 TriggerSpec

- [x] 增加 Trigger Schema、SQLite 存储、CLI 和控制协议。
- [x] 支持 Manual、Schedule 和 Dataset 三类 Trigger。
- [x] 建立 occurrence / dataset version / request key 幂等、并发租约、fencing 和配置审计。
- [ ] 增加 bounded catch-up 的多周期补偿和可视化运行日历；当前 Schedule 每周期至多运行一次，重启后按 `run_once` 语义处理当前周期。

### P2：事件和产品入口

- 增加 Domain Event 和受信 External Event。
- 开发者控制台提供启停、最近运行和下一次计划。
- 业务 App 只展示业务计划和结果，不暴露内部协议。

## 11. 验收标准

- 停止 Codex 后，已启用 Workflow 仍按计划运行。
- 同一计划时间最多创建一个有效 Run。
- 上一轮未完成时不叠加执行。
- 进程崩溃后根据租约和运行记录确定恢复或跳过。
- Trigger 可追溯到 Workflow、Node、Adapter 和 Dataset 版本。
- 人工、定时和数据集触发共享权限与审计边界。
- 业务人员无需理解 Codex、Session、Run ID 或内部脚本即可启停自动化。
