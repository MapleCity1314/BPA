---
title: Control Hello
description: bpa.control/hello/1 的协商顺序、帧边界、错误语义和兼容策略。
---

新 CLI、Console 和 MCP 客户端在发送业务请求前，先用
`bpa.control/hello/1` 协商应用协议、帧上限和功能位。成功后继续使用
`bpa.control/1`。

## Hello

```json
{
  "version": "bpa.control/hello/1",
  "kind": "hello",
  "requestId": "hello-01",
  "supportedApplicationProtocols": ["bpa.control/1"],
  "runtime": { "name": "example-client", "version": "0.4.0" },
  "maxFrameBytes": 524288,
  "features": ["evidence_refs", "resource_bindings"]
}
```

Server 按自身优先级选择第一个公共应用协议；帧上限取双方较小值；功能位取交集。
协商信封不携带业务参数或大型能力清单。

## 错误

| 错误码 | 含义 |
| --- | --- |
| `MALFORMED_HELLO` | 首帧无法按严格结构解释 |
| `NO_COMMON_APPLICATION_PROTOCOL` | 双方没有公共应用协议 |
| `FRAME_LIMIT_TOO_SMALL` | 协商结果无法承载最小控制信封 |

错误响应固定要求 `connection: "close"`。只关闭当前连接，不终止 Core。

## 帧边界

控制面硬上限为 512 KiB。Dataset、图片、DOM 和其他大型正文不能降级进入 Control；
它们必须走 Staging Lease 或 Browser Evidence Transport。

旧客户端只在显式 legacy adapter 范围内兼容。新客户端不能在协商失败后猜测能力并
继续发送业务帧。
