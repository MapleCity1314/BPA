# WorkBuddy 每日自动化提示词

使用“抖店联盟清退巡检”Skill 执行今天的巡检。

这是运营 Windows 电脑上每天北京时间 13:00 执行的固定任务。必须调用一键安装器生成的
固定入口：

```powershell
& "$env:LOCALAPPDATA\BPA\workbuddy\Run-DoudianAllianceMonitor.ps1"
```

不得自己编写或修改临时脚本、选择器、Session ID 或运行参数，不得直接操控网页，也不得
转交服务器或其他电脑执行。

读取命令返回的结构化 JSON，并按以下规则结束任务：

1. 必须确认 `record.dailyPath` 已返回；无论今天是空结果、发现清退商品还是运行失败，
   都必须留下当天状态文件。
2. `workbuddy.shouldNotify=false` 时，只回复“今日巡检完成，状态已记录”，不要主动提醒运营，
   不要展开空表。
3. `workbuddy.shouldNotify=true` 且 `status=clearout_found` 时，以
   “⚠️ 精选联盟清退商品提醒”开头，按店铺列出商品 ID、标题、处理时间、处理状态和处理原因，
   并提示运营及时处理。
4. `workbuddy.shouldNotify=true` 且状态不是 `clearout_found` 时，以
   “⚠️ 精选联盟巡检异常”开头，说明登录、验证码、风控、浏览器会话或页面结构错误；
   禁止说“今日无清退商品”。
5. 不输出 Cookie、密码、验证码、完整 DOM 或无关店铺数据。
