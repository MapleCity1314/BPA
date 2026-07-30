---
title: Workflow v1alpha1
description: BPA 声明式 Workflow 的输入输出、节点图、风险与失败分支。
---

**状态：v1alpha1**

v1alpha1 是保持兼容的线性/图式资产格式。新建的结构化流程优先使用
[v1alpha2 / v1alpha3](../structured/)；已有资产和 Run 不需要迁移。

Workflow 描述业务结果和节点图，不包含任意 JavaScript、`eval`、动态远程代码或未注册的浏览器动作。

## 顶层结构

```yaml
apiVersion: bpa/v1alpha1
kind: Workflow
metadata:
  id: order.export
  version: 0.1.0
  title: 导出指定日期的订单
spec:
  riskLevel: R0
  inputSchema: {}
  outputSchema: {}
  start: open_orders
  nodes: {}
```

`metadata.id` 使用稳定资产标识，`metadata.version` 使用 SemVer。已发布版本不应原地覆盖。

## 节点引用

每个节点至少包含一个固定版本引用：

```yaml
open_orders:
  use: browser.navigate@1.0.0
  with:
    url: https://example.com/orders
  timeout: 15s
  next: read_orders
```

节点可以声明 `next`，或使用 `on` 映射 `success`、`failure`、`timeout`、`rejected`、`cancelled` 与 `uncertain`。

## Retry 与 Timing

Workflow 级节点配置可以声明有限次数重试、退避和可重试错误。TimingPolicy 作为独立公共模型描述页面就绪、确定性抖动和限速边界。

Alpha 标识表示结构仍可能调整。实现方应固定完整版本，并对 Schema 变化执行兼容性测试。

Core 会把 v1alpha1 编译为与新 Workflow 相同的 `bpa.workflow-ir/2`。Run 创建后
保存 Plan Snapshot，因此后续发布新的 Workflow 或 Node 不会改变执行中的任务。

[下载 Workflow Schema](../../../reference/schemas/)
