---
title: Browser Session 与登录
description: 理解浏览器资源、精确绑定、认证状态和登录失效后的人工接管。
---

Browser Session 表示 BPA Extension 与 Core 之间的一条已协商连接，也代表一个明确
的浏览器登录上下文。它不是普通 Workflow 输入。

## Session 需要满足什么

每个 Browser Node 可以声明：

- 所需 Capability 和精确 Node 版本。
- 允许的 Origin。
- 最低认证等级。
- 资源用途，例如业务页面或公开资产来源。

Workflow 把这些要求映射到命名 Resource Slot。创建 Run 时，操作者选择精确
Session；Core 保存 Capability Digest、Origin、认证状态和绑定时间的快照。

## 派发前仍会复核

冻结快照不代表 Session 永远有效。每次 Browser Command 派发前都会重新验证：

1. Session 仍然连接或可安全恢复。
2. Capability Digest 没有漂移。
3. 当前 Origin 在允许范围内。
4. 认证等级满足 Node Requirement。
5. Fencing Token、TabRef 和 Page Epoch 仍然有效。

不满足时不会自动改绑到另一个 Session。

## 登录、验证码和风控

登录失效会创建 `auth_takeover` 或同类 Human Action，Run 停在原 Checkpoint。
用户完成正常登录后再继续。BPA 不自动填写验证码，不规避会员权限、限流或平台
风控。

如果只有一个来源失效，已完成的其他来源证据仍然保留，不会从头重复采集。

## 重连

Native Host 或 Extension 重连时使用 Resume Token 恢复原 Session 身份，并轮换
Token。旧 Token、旧 Fencing Token 和迟到 Result 可以进入审计，但不能推进当前
Run。

协议细节见 [Browser Resource Binding](../../control/resource-binding/)。
