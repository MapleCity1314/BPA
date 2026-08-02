---
name: doudian-alliance-retired-monitor
description: 在运营 Windows 电脑的 WorkBuddy 中一键安装、恢复或运行抖店精选联盟逐店清退商品日巡检。用于安装随 Skill 交付的 BPA Runtime 和固定资产，从抖店商品管理页进入精选联盟，逐个切换当前账号下的正常营业店铺，处理联盟首页广告弹窗，读取已清退商品，每天落盘状态，并在发现清退商品或巡检失败时提醒运营；也用于处理首次 Chrome 扩展授权、抖店登录、浏览器 Session 选择或页面结构变化造成的阻断。不要用于修改、检查或现场修补 Runtime、扩展、工作流、商品、佣金、推广策略或店铺设置，也不要绕过平台验证。
---

# 抖店精选联盟清退商品巡检

该 Skill 运行在运营人员自己的 Windows 电脑和 WorkBuddy 自动化任务中。正式交付包已
内置 Windows x64 BPA Runtime、固定 Node/Adapter/Workflow 和确定性安装脚本。不要在
运行时编写选择器、JavaScript 或临时浏览器脚本，不把任务转交公司服务器。

## 首次安装或恢复

读取 [references/workbuddy-install-prompt.md](references/workbuddy-install-prompt.md)，按其
固定流程执行随 Skill 交付的
`scripts/Install-DoudianAllianceMonitor.ps1`。必须使用安装中 Skill 的真实资源路径作为
`-SkillRoot`，不要把脚本复制或改写到工作空间。

安装或验收失败时不得分析并修改 Runtime/扩展/Workflow 内部脚本，不得绕过校验、迁移、
构建身份或 smoke test，不得手工修改版本指针。只允许按安装器结构化
`requiredHumanActions` 完成人工浏览器步骤；`install_failed` 必须停止并交回 BPA 开发修复。

安装器会校验 Runtime SHA-256、安装或复用正确版本、启动 BPA Core、验证并发布固定资产、
创建日记录目录和固定运行入口，然后对 Native Host、Browser Instance、Content Script、
登录店铺身份和 source tab 做真实验收。它是可恢复且幂等的；安装器返回需要人工处理的
状态时，完成 `requiredHumanActions` 后重新执行即可。

只允许人工完成以下安全步骤：

1. 在 Chrome 扩展页开启开发者模式并加载安装器返回的 `extensionPath`。
2. 在抖店商品管理页完成登录、验证码或平台风控确认。
3. 多个合格 Browser Instance 同时存在时，由运营确认要使用的 Chrome 实例。

不得请求 Cookie、密码或验证码。安装器返回 `ready` 时已经执行过一次只读 smoke test；
只有 `smokeTest.dailyPath` 存在才算部署完成。长期配置只保存稳定的 Browser Instance ID，
每次定时运行都会重新解析当前合格的 Session 和抖店标签页。
`smoke_test_failed` 即使已经写入日记录也不代表安装成功，必须按错误码恢复后重新验收。

## WorkBuddy 自动化

本项目的正式部署目标是运营人员的 Windows 电脑。WorkBuddy 自动化必须使用以下固定
配置：

- 名称：`抖店精选联盟清退商品日巡检`
- 工作空间：安装器返回的 `recordsDir`
- 技能：`抖店联盟清退巡检`
- 定时规则：每天 `13:00`
- 时区：`Asia/Shanghai`
- 生效日期：长期有效
- 推送到 WorkBuddy：开启
- 提示词：使用
  [references/workbuddy-automation-prompt.md](references/workbuddy-automation-prompt.md)

自动化只调用安装器生成的固定入口：

```powershell
& "$env:LOCALAPPDATA\BPA\workbuddy\Run-DoudianAllianceMonitor.ps1"
```

如果当前任务不是 WorkBuddy 自动化配置界面，不能声称已经创建定时任务；应返回安装器
给出的自动化名称、工作目录、技能、提示词、每天 13:00 和开启推送，指导运营在 WorkBuddy
自动化页面完成最后一次保存。不要写入未公开的 WorkBuddy 内部数据库或伪造自动化配置。

## 结果处理

- 每次运行都必须确认命令返回了 `record.dailyPath`；文件按上海业务日期保存为
  `YYYY-MM-DD.json`，同日重跑追加到 `attempts`，并同步更新 `latest.json`。
- `status=complete_empty` 且 `retiredProductCount=0`：报告本轮所有已发现且正常营业店铺均未发现
  清退商品；日状态记为 `no_clearout`，`shouldNotify=false`，不主动打扰运营。
- `status=complete_with_items` 且 `retiredProductCount>0`：立即报告。按店铺列出商品 ID、商品标题、
  处理时间、处理状态和处理原因；日状态记为 `clearout_found`，`shouldNotify=true`。
- `status=partial`：日状态记为 `incomplete` 并提醒运营，列出失败店铺和错误码；禁止描述为
  全部正常。
- `status=blocked`、Workflow `rejected` 或 `uncertain`：报告需要人工恢复运营电脑上的浏览器，
  日状态必须落为 `incomplete` 或 `runtime_error`，明确区分登录失效、验证码、风控、
  店铺身份不一致和页面结构变化。

## 固定边界

- 必须从抖店入口进入精选联盟；不得用清退页深链冷启动会话。
- 百应页面不能切换店铺；每个店铺都要回抖店完成切店验证后重新进入联盟。
- 广告弹窗只关闭已确认的 `role=dialog`，从最上层到最下层处理；未知弹窗阻断。
- 任何店铺身份无法确认时失败关闭。页面显示“无搜索结果”只有在表头契约完整时才可解释为
  0 条。
- 不点击“新增推广策略”“立即体验新版”等业务按钮，不修改任何商品或推广配置。
- 验证码、登录失效和风控信号不自动重试，也不绕过。
- 不自动修改 WorkBuddy 私有配置数据库；定时任务只通过 WorkBuddy 官方自动化界面保存。

## 告警格式

先给结论，再给证据：

```text
【精选联盟清退商品告警】
巡检时间：...
扫描店铺：已扫描 n / 已发现 n，跳过 n，失败 n
受影响店铺：n
清退商品：n

店铺：...
- 商品ID / 商品名
- 处理时间
- 处理状态
- 处理原因
```

没有清退商品时只在 WorkBuddy 任务历史中保留简短完成结果，不触发运营提醒；不输出
Cookie、账号凭据、完整页面 DOM 或无关店铺数据。
