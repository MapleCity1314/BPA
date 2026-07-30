---
title: 可信证据与资产
description: Browser Evidence、SourceRecord、AssetRecord、EvidenceLink 和本地内容寻址存储。
---

## 四类对象

| 对象 | 责任 |
| --- | --- |
| SourceRecord | 来源、时间、访问范围、分类和精确 Adapter 身份 |
| Evidence v1 | 某次 Node Execution 产生或使用的验证材料 |
| AssetRecord | 不可变 Blob 的摘要、媒体属性、派生关系和保留策略 |
| EvidenceLink | 把 Run/Execution/Evidence 与 Source/Asset 连接起来 |

这些对象都不复制正文。正文存放在 SHA-256 内容寻址存储，SQLite 保存元数据和引用。

## Browser Evidence 顺序

```text
evidence.begin
→ evidence.chunk × N
→ evidence.complete
→ evidence.ack(accepted=true)
→ command.result(evidence_refs)
→ result.ack
```

Evidence 必须先完整落盘并收到 ACK，Result 才能引用。每块最多 256 KiB；块摘要、
完整摘要、大小、所有权、Session 和 Fencing Token 都要匹配。

相同块可以幂等补发；相同 Evidence ID 的不同正文会被拒绝。Core 重启后根据持久化
状态返回 `next_chunk_index`。

## 存储与保留

- 单 Blob 默认最多 25 MiB。
- 单 Run 上限 2 GiB。
- 本地总存储达到 10 GiB 时告警，不静默删除。
- restricted/confidential 页面材料默认 24 小时。
- 未引用的公开研究资产默认 30 天。
- 被有效资产包引用的 Asset 在引用解除前不能删除。

`storageRef` 由 Core 产生，是不透明引用，不是调用方路径或公开 URL。
