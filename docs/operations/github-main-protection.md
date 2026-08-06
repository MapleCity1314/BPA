# GitHub `main` 交付保护

> 文档类别：运维现状与恢复说明。  
> 适用仓库：`MapleCity1314/BPA`。  
> 生效时间：2026-08-06。

## 1. 目标

`main` 只接收经过 Pull Request 和完整交付闭包验证的提交。合并权限、管理员权限或
GitHub Actions 的瞬时故障都不能替代验证结果。

## 2. 当前保护

GitHub Branch Protection 对 `main` 启用以下约束：

- 必须通过 Pull Request 合并；当前单维护者阶段不要求第二人批准；
- 分支必须与最新 `main` 保持同步；
- 管理员同样受保护规则约束；
- 所有 review conversation 必须解决；
- 禁止 force-push 和删除 `main`；
- 下列检查全部为 required：
  - `build`
  - `verify`
  - `verify-windows`
  - `performance-gate`
  - `release-package`
  - `release-package-windows (1)`
  - `release-package-windows (2)`
  - `verify-windows-reproducibility`
  - `release-workbuddy-skill`
  - `validate-workbuddy-skill-windows`

`deploy` 不属于 Pull Request 门禁：该 job 只在主线发布条件成立时运行，在 Pull Request
中按设计为 skipped。

## 3. 故障处理

GitHub Runner 在 `Set up job` 阶段发生 `Service Unavailable`、`Bad Gateway` 或 action
下载失败时，视为基础设施故障，不视为代码通过。等待 workflow 终态后只重跑失败 job；
在 required checks 全部成功前不得合并。

如果 workflow 重命名 job，必须在同一个变更窗口核对新 check context，并由仓库管理员
更新 Branch Protection。不得临时关闭保护或直接推送 `main` 来解除死锁。

## 4. 只读审计

使用已登录且具备仓库读取权限的 GitHub CLI：

```bash
gh api repos/MapleCity1314/BPA/branches/main/protection \
  --jq '{
    strict: .required_status_checks.strict,
    contexts: .required_status_checks.contexts,
    enforceAdmins: .enforce_admins.enabled,
    conversations: .required_conversation_resolution.enabled,
    forcePushes: .allow_force_pushes.enabled,
    deletions: .allow_deletions.enabled
  }'
```

审计结果不得包含 GitHub token 或本机认证文件。仓库文档记录的是预期状态；GitHub API
回读才是当前外部状态证据。
