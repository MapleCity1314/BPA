# Windows x64 RC 安装与验证

## 支持边界

- Windows 11 x64。
- Google Chrome。
- 当前用户安装，不要求系统 Node.js。
- 数据默认位于 `%LOCALAPPDATA%\BPA`。
- 当前为 RC 候选；未签名安装包可能触发 Windows 安全提示。

## 安装

解压 RC ZIP 后，在 PowerShell 中运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\bpa\install.ps1
```

安装器会验证归档、加载内置 Node.js 24 和 SQLite 原生模块、在数据库副本上演练
Migration、备份现有数据库、安装 Extension 文件、注册当前用户 Native Host，
启动 Core 并执行健康检查。

Chrome 的开发者模式扩展目录为：

```text
%LOCALAPPDATA%\BPA\extension
```

安装后应完全退出并重新打开 Chrome，使其获得更新后的当前用户环境和 Native
Host 注册。

## 诊断

```powershell
& "$env:LOCALAPPDATA\BPA\bin\bpa.cmd" doctor
& "$env:LOCALAPPDATA\BPA\bin\bpa.cmd" console
```

正常结果必须至少包含可写 SQLite、Core `ok` 和 Browser Protocol 版本。Chrome
会话只有在扩展加载并连接后才显示 ready。

## 回滚与卸载

运行时指针回滚：

```powershell
.\bpa\rollback.ps1
```

回滚先验证旧 Runtime 闭包及其数据库 Schema 上限；不兼容时会在停止 Core 前
直接拒绝。兼容时按“安全核验并停止 Core、原子切换 Runtime 与 Extension、重启、
Doctor”执行，任一步失败都会恢复原指针、Extension 和 Core。回滚不会执行数据库
down migration，也不会自动用旧备份覆盖包含新业务写入的数据。

默认卸载保留业务数据与备份：

```powershell
.\bpa\uninstall.ps1
```

只有明确需要清理业务数据时：

```powershell
.\bpa\uninstall.ps1 -PurgeData
```

安装、回滚和卸载只会终止经结构化锁、Runtime identity、可执行文件路径与命令行
共同验证的 BPA Core。锁文件过期或 PID 被其他进程复用时，脚本会拒绝结束该进程
并给出错误，而不会强制杀进程。

## 当前验收门

- Windows CI 原生构建与原生模块加载。
- 当前用户安装、重启、升级和卸载。
- Chrome Native Host 连接。
- 真实只读 Workflow。
- 未签名包的分发提示与 SHA-256 核对。
