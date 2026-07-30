---
title: 业务工作台
description: 本地 Operator Console 的入口、安全会话、运行向导和当前功能范围。
---

Operator Console 是业务人员的主要入口；CLI 保留给发布、运维和高级诊断。

## 启动与安全会话

```text
CLI launches temporary console host
→ binds a random 127.0.0.1 port
→ opens a one-time URL fragment token
→ exchanges it for an HttpOnly, SameSite=Strict session
→ console host calls Core through the local Control socket
```

Console 不监听局域网，不启用 CORS，不直连 SQLite。Host、Origin、CSRF 和严格 CSP
都在服务端检查。

## 当前页面

- 系统健康与 Browser Session 状态。
- 已发布只读 Workflow 的启动向导和资源槽位绑定。
- Run 时间线、当前步骤与业务化状态。
- “无需监管 / 请关注 / 需要操作”任务中心。
- Dataset 安全上传、校验与不可变发布。
- Evidence、Source 和 Asset 血缘查看。
- Export 元数据与报告入口。

## 文件不会经过控制协议

浏览器先申请一次性 Staging Lease，再把正文发送到权限受限的独立本机 Socket。
Core 校验大小、摘要、MIME 和用途后转入内容寻址存储。Dataset 导入只引用不可变
上传回执，不接受浏览器提交的本地路径。

## 当前限制

正式资产发布仍需 CLI 人工确认。Console 不提供 R2+ 写授权，也不会自动处理登录、
验证码或平台风险控制。完整 Export 正文下载仍属于后续能力。
