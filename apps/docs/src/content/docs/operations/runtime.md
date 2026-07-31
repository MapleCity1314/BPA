---
title: 安装与升级边界
description: 固定 Node.js 运行时、生产闭包、SQLite Migration、健康检查与安全回滚。
---

## 生产闭包

桌面端本地包包含固定 Node.js 24、Core、CLI、Native Host、MCP、Team Worker、
Extension、Operator Console、正式 Schema/资产、SBOM 和逐文件摘要。

生产 allowlist 不包含完整源码、开发依赖、缓存、测试、个人 Skill 或用户文件。

## 升级

```text
checkpoint SQLite
→ create backup
→ run append-only migrations on a copy
→ verify integrity
→ install new immutable runtime
→ atomically switch current pointer
→ health check Core / DB / Socket / Host / Extension
```

Migration 失败时不能切换版本。健康检查失败可以恢复旧 Runtime；只有在确认新版本
没有业务写入时才能恢复数据库快照。

## 回滚

不提供 down migration。旧 Runtime 如果不认识新数据库 Schema，应明确拒绝启动，
而不是用旧代码写入新表结构。安装器保留上一版本和备份，以便在兼容范围内恢复。

macOS arm64 是已验证基线；Windows 11 x64 已进入 CI 原生构建与当前用户安装的
RC 候选阶段。Windows 真机 Chrome 与真实只读 Workflow 验收完成前，不应把它写成
正式稳定支持。签名、公证、SmartScreen 声誉、商店或企业策略分发不属于当前候选
闭环。
