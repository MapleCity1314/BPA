---
title: 数据与保留
description: 本地数据分类、内容寻址存储、上传安全、删除约束与审计。
---

## 默认本地

当前版本使用 SQLite 保存状态和元数据，使用本地内容寻址目录保存大型正文。没有
PostgreSQL、云对象存储或远程 Gateway。

## 分类

```text
public
internal
confidential
restricted
```

分类决定读取权限和默认保留期。Runtime 可以把 confidential/restricted 收敛为
`sensitive`，但不能反向抹掉原始分类。

## 上传边界

- 调用方不能指定最终路径。
- 文件名、URL、MIME 和路径都视为不可信输入。
- Staging Lease 一次性、限时、限大小，并绑定用途。
- Core 重新计算 SHA-256；摘要不匹配时拒绝。
- 符号链接、路径穿越和非普通文件不进入受信读取。

## 删除

保留任务只处理到期且不再被有效引用的对象。进入有效资产包、Export 或 Evidence
关系的 Asset 不能静默删除。显式删除必须记录 Audit。

卸载 Runtime 默认保留业务数据；清理数据需要独立、明确的破坏性操作。
