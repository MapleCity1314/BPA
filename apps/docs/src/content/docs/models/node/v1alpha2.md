---
title: Node v1alpha2
description: 资源感知 Browser Node 的能力、Origin、认证等级和版本冻结规则。
---

Node v1alpha2 保留 v1alpha1 的输入、输出、风险、执行和错误契约，并为 Browser
Runtime 增加 `resources`。

## Browser Resource Requirement

每个 Requirement 声明：

- 当前 Node 内唯一的 key。
- 所需浏览器能力。
- 允许的 Origin。
- 最低认证等级。
- 面向操作者的用途说明。

认证等级按以下顺序收紧：

```text
anonymous < optional < authenticated < membership
```

Workflow 映射时，Slot 的能力必须包含 Requirement，Origin 不能扩大，认证等级不能
降低。

## 兼容规则

- 只有 Browser Node 可以声明 `resources`。
- Browser Node v1alpha2 必须声明至少一个资源。
- v1alpha1 Node 保持原行为，不会被推断出 Resource Slot。
- Single Node Run 不能猜测资源感知 Node 所需的 Browser Session。
- 新 Requirement 或 Adapter 行为需要新 Node 版本，不能覆盖已有版本。

资源要求属于权限边界，不应作为普通 input 让页面或模型动态填写。
