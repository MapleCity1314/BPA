---
title: 使用本地工作台
description: 启动 BPA Operator Console，理解健康状态、导航和当前产品边界。
---

Operator Console 是日常运行 BPA 的主要入口。它把系统健康、浏览器会话、Workflow、
人工任务、Dataset 和证据放在同一处；CLI 主要保留给资产发布和高级诊断。

## 启动前确认

1. Local Core 已经运行。
2. Google Chrome 已加载 BPA Extension。
3. 需要访问的平台页面已经由用户正常登录。
4. 准备运行的 Workflow 和 Node 已正式发布。

在开发环境运行：

```bash
pnpm bpa console
```

安装后的 Runtime 直接运行：

```bash
bpa console
```

CLI 会启动一个临时 Console Host，并在浏览器打开只使用一次的入口。入口 Token
位于 URL fragment，不会发送给其他站点；交换成功后使用 `HttpOnly`、
`SameSite=Strict` Session。

## 先看系统状态

首页会把状态归为三类：

| 状态 | 含义 | 建议 |
| --- | --- | --- |
| 无需监管 | Core 与资源正常，没有等待处理的任务 | 可以离开工作台 |
| 请关注 | 某项资源状态变化，但流程可能仍能继续 | 查看对应 Run 或 Session |
| 需要操作 | 流程正在等待登录、确认或人工动作 | 打开任务中心处理 |

Browser Session 卡片会显示 Origin、用途、认证状态和最后活动时间。它只是当前已连接
资源的视图，不会替用户登录或自动选择其他账号。

## 日常入口

- **启动任务**：选择已发布 Workflow、填写输入并绑定精确 Browser Session。
- **运行记录**：按 Run ID 查看当前步骤和有序事件。
- **任务中心**：完成 Human Confirm、Human Action 等人工步骤。
- **数据集**：通过 Staging Lease 上传并发布经过审核的 `.xlsx` Profile。
- **证据与报告**：按 Run 查看 Source、Evidence、Asset 和已有导出。

继续阅读：[启动 Workflow](../run-workflow/) ·
[处理人工任务](../assistance-tasks/) ·
[查看证据](../evidence-assets/)

## 当前限制

工作台不发布正式 Workflow、Node、Adapter 或 Policy，也不授予 R2+ 浏览器写权限。
遇到验证码、登录失效或平台风控时，它只会提示并暂停对应资源。
