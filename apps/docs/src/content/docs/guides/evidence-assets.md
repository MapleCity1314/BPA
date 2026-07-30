---
title: 查看证据与资产
description: 从 Run 追溯 Source、Evidence、Asset、摘要、保留策略和导出记录。
---

BPA 不把“节点返回成功”直接等同于业务事实。可信结果由来源、执行身份、Evidence、
不可变 Asset 和 Audit 共同支撑。

## 在工作台查看血缘

在“证据与报告”中输入 Run ID，可以查看：

- `SourceRecord`：信息来自哪里、何时访问、使用哪个 Adapter。
- `Evidence`：哪次 Node Execution 产生了什么验证材料。
- `AssetRecord`：正文 Blob 的 SHA-256、MIME、大小和派生关系。
- `EvidenceLink`：Run、Execution、Source 与 Asset 之间的关系。
- `Export`：已经登记的报告或资产包导出。

工作台展示的是元数据和受限下载入口，不会把本机存储路径暴露给页面。

## 为什么正文不在 SQLite

大型正文存放在本地内容寻址存储：

```text
assets/sha256/<prefix>/<digest>
```

SQLite 只保存元数据、引用和审计。调用方不能指定最终路径，相同内容按摘要去重，
仍保留不同 Source 和业务语义。

## Browser Evidence 顺序

```text
begin → chunk × N → complete → evidence ACK
→ command result(evidence_refs) → result ACK
```

Result 抢跑、跨 Run 引用、摘要冲突或旧 Fencing Token 都不能推进 Engine。

保留策略和删除约束见[数据与保留](../../operations/data-security/)。
