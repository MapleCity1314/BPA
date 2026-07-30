---
title: Dataset 与 Decision
description: 不可变 DatasetVersion、受限读取、Decision Candidate 与可撤销 DecisionRecord。
---

## Dataset 导入

```text
Core-issued upload lease
→ verified content-addressed Blob
→ Dataset Profile parse
→ schema and digest validation
→ normalized records
→ atomic DatasetVersion publish
```

相同 Dataset ID + version 不能覆盖。Run 保存 DatasetRef；Runtime 通过分页、限量的
Query Port 读取记录，不接收任意文件路径。

当前本地工作台只公开经过审核的 `.xlsx` Profile。文件正文走独立上传通道，Control
只传回执和 Dataset 元数据。

## Decision Candidate 与 DecisionRecord

AI 或匹配器产生的是 Candidate，不是长期决定。只有人工确认后才能创建 active
DecisionRecord。

DecisionRecord 保存：

- 精确 scope。
- 前置摘要。
- 版本化结果值。
- 确认主体与时间。
- 可选的替代或撤销关系。

复用时必须同时匹配 scope 和 precondition digests。`superseded` 与 `revoked`
记录保留审计，但不能继续复用。
