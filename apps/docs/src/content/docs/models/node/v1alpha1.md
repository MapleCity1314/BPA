---
title: Node v1alpha1
description: BPA 节点能力、运行时、风险、幂等与 Evidence 契约。
---

**状态：v1alpha1**

Node 是提前注册、测试和版本化的能力。Workflow 只能引用 Node，不能在运行时内嵌代码。

## 必需信息

| 分组 | 内容 |
| --- | --- |
| `metadata` | ID、SemVer、标题与说明 |
| `runtime` | `engine_builtin`、`engine_team`、`browser`、`human` 或 `composite` |
| `inputSchema` | 节点输入的 JSON Schema |
| `outputSchema` | 节点输出的 JSON Schema |
| `risk` | R0–R4、权限与浏览器域名 |
| `execution` | 默认超时、幂等类别、可重试错误与取消能力 |
| `errors` | 节点可能返回的稳定错误代码 |

## 幂等类别

```text
pure
repeatable_read
verified_write
non_repeatable
```

`verified_write` 要求动作后验证；`non_repeatable` 不得因普通超时自动重做。

## 浏览器节点

`runtime: browser` 的节点必须声明至少一个允许域名。实际执行仍需 Command 内的 Permission Grant 同时覆盖该域名和权限。

RiskSignal 可以由页面、Adapter 或 Bridge 产生。Node 的风险配置不能降低全局策略或平台阻断信号。

[下载 Node Schema](../../../reference/schemas/)
