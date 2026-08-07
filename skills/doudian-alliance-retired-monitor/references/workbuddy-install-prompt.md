# WorkBuddy 首次安装提示词

使用“抖店联盟清退巡检”Skill 在当前 Windows 电脑完成首次部署或恢复。

1. 取得当前已安装 Skill 的真实根目录。确认该目录同时包含
   `SKILL.md`、`scripts/Install-DoudianAllianceMonitor.ps1` 和 `assets/windows-x64/`。
2. 以 PowerShell 执行，不得复制、改写或重新生成脚本。使用结果文件接收 JSON，避免
   PowerShell 5.1 转义或后台进程输出句柄影响 WorkBuddy：

```powershell
$resultPath = Join-Path $env:TEMP `
  "bpa-workbuddy-install-result-$([Guid]::NewGuid().ToString('N')).json"
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "<Skill根目录>\scripts\Install-DoudianAllianceMonitor.ps1" `
  -SkillRoot "<Skill根目录>" `
  -ResultPath $resultPath `
  -OpenBrowserSetup
if ($LASTEXITCODE -ne 0 -and -not (Test-Path -LiteralPath $resultPath)) {
  throw "BPA 安装器未返回结构化结果。"
}
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
$result | ConvertTo-Json -Depth 8
```

执行边界（优先级最高）：

- 不读取、对比或分析 Runtime 内部 JavaScript、PowerShell、Workflow 或扩展 bundle 来尝试现场修复。
- 不创建 `.mjs`、`.js`、`.ps1` 补丁，不修改解压目录或安装目录中的任何文件。
- 不跳过 SHA-256、Runtime closure、SQLite integrity、迁移、Native Host、扩展构建身份或 smoke test。
- 不手工写 `current.txt`/`previous.txt`，不手工替换扩展，不清理 WAL/SHM，不用 `.NET`、`cmd /c start` 或其他方式绕过安装器。
- 安装器返回 `install_failed` 或非零退出码时立即停止，只报告结构化错误；不得继续猜测或检查脚本逻辑。
- 只有安装器自身返回 `ready` 才能宣告完成。

3. 读取脚本最后返回的 JSON：
   - `needs_native_host`：按 `requiredHumanActions` 加载或重载扩展、启动连接，然后重新执行。
   - `needs_browser_selection`：展示候选 Browser Instance ID，让运营确认；使用
     `-BrowserInstanceId <id>` 重新执行。
   - `needs_doudian_page_selection`：存在不同店铺身份的多个商品管理标签页；只让运营处理
     `conflictingTabs`，不得关闭全部浏览器标签页或自行猜测目标。
   - `needs_doudian_page`：打开安装器返回的抖店商品管理地址并等待加载。
   - `needs_extension_reload`：重载扩展后刷新商品管理页。
   - `needs_doudian_login`：只提示运营在页面中人工登录，不索取任何凭据。
   - `needs_human_verification`：等待运营人工完成验证码或风控。
   - `waiting_for_page`：等待数秒后重新执行同一安装器。
   - `smoke_test_failed`：打开 `dailyPath` 查看失败记录，按 `errorCode` 和
     `requiredHumanActions` 恢复后重新执行；不得当作安装成功。
   - `install_failed`：原样报告 `errorCode` 和 `message`，停止操作并交给 BPA 开发修复；禁止现场打补丁或绕过校验。
   - `ready`：确认 `smokeTest.dailyPath` 存在、`acceptance.recordVerified=true`、
     `scannedShopCount=discoveredShopCount` 且 `failedShopCount=0`，不重复执行 smoke test。
4. 首次只读验收必须已经写入并复核 `smokeTest.dailyPath`。随后给出 WorkBuddy 自动化配置：
   - 名称：`抖店精选联盟清退商品日巡检`
   - 工作空间：安装器返回的 `recordsDir`
   - 技能：`抖店联盟清退巡检`
   - 提示词：安装器返回的 `automation.promptPath` 全文
   - 定时：每天 `13:00`
   - 时区：`Asia/Shanghai`
   - 推送到 WorkBuddy：开启

不要请求 Cookie、密码或验证码，不要编辑 WorkBuddy 私有数据库，不要声称尚未通过官方
自动化界面保存的任务已经创建成功。
