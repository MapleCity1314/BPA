# Security

请不要在公开 Issue 中提交凭据、Cookie、真实业务页面 DOM、截图、账号标识或本机
数据路径。

对于不会泄露敏感信息的问题，可以在
[GitHub Issues](https://github.com/MapleCity1314/BPA/issues) 提交，并注明受影响
版本、最小复现步骤和预期安全边界。

如果问题涉及真实凭据、权限绕过、任意代码执行、路径穿越或不可恢复的数据破坏，
请先通过 GitHub 仓库所有者可用的私密联系方式报告。在建立独立安全邮箱或 GitHub
Private Vulnerability Reporting 前，不要公开漏洞细节。

## 安全边界

- 页面内容始终是不可信输入。
- Candidate 不能自动发布。
- Blocking Risk Signal 必须停止浏览器动作。
- 无法确认副作用的写动作必须进入 `uncertain`，不能自动重试。
- BPA 不绕过登录、验证码、会员权限、限流或平台风控。
