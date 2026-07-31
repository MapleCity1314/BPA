# WorkBuddy 首次安装提示词

使用“抖店联盟清退巡检”Skill 在当前 Windows 电脑完成首次部署或恢复。

1. 取得当前已安装 Skill 的真实根目录。确认该目录同时包含
   `SKILL.md`、`scripts/Install-DoudianAllianceMonitor.ps1` 和 `assets/windows-x64/`。
2. 以 PowerShell 执行，不得复制、改写或重新生成脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "<Skill根目录>\scripts\Install-DoudianAllianceMonitor.ps1" `
  -SkillRoot "<Skill根目录>" `
  -OpenBrowserSetup
```

3. 读取脚本最后返回的 JSON：
   - `needs_native_host`：按 `requiredHumanActions` 加载或重载扩展、启动连接，然后重新执行。
   - `needs_browser_selection`：展示候选 Browser Instance ID，让运营确认；使用
     `-BrowserInstanceId <id>` 重新执行。
   - `needs_doudian_page`：打开安装器返回的抖店商品管理地址并等待加载。
   - `needs_extension_reload`：重载扩展后刷新商品管理页。
   - `needs_doudian_login`：只提示运营在页面中人工登录，不索取任何凭据。
   - `needs_human_verification`：等待运营人工完成验证码或风控。
   - `waiting_for_page`：等待数秒后重新执行同一安装器。
   - `smoke_test_failed`：打开 `dailyPath` 查看失败记录，按 `errorCode` 和
     `requiredHumanActions` 恢复后重新执行；不得当作安装成功。
   - `ready`：确认 `smokeTest.dailyPath` 存在，不重复执行 smoke test。
4. 首次只读验收必须已经写入 `smokeTest.dailyPath`。随后给出 WorkBuddy 自动化配置：
   - 名称：`抖店精选联盟清退商品日巡检`
   - 工作空间：安装器返回的 `recordsDir`
   - 技能：`抖店联盟清退巡检`
   - 提示词：安装器返回的 `automation.promptPath` 全文
   - 定时：每天 `13:00`
   - 时区：`Asia/Shanghai`
   - 推送到 WorkBuddy：开启

不要请求 Cookie、密码或验证码，不要编辑 WorkBuddy 私有数据库，不要声称尚未通过官方
自动化界面保存的任务已经创建成功。
