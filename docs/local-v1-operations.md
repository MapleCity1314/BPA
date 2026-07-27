# BPA 本地 v1 运行与验收

## 1. 开发运行

要求 Node.js 24 LTS、pnpm 10；正式包不读取用户系统 Node。

```bash
pnpm install --frozen-lockfile
pnpm schema:check
pnpm typecheck
pnpm test
pnpm build
```

启动 Core：

```bash
pnpm core
pnpm bpa doctor
```

## 2. 发布首个只读 Workflow

Published Artifact 不允许用相同 `asset_id + version` 覆盖。以下动作会写入 Audit：

```bash
pnpm bpa publish node nodes/core/control.start.node.yaml --yes
pnpm bpa publish node nodes/core/control.succeed.node.yaml --yes
pnpm bpa publish node nodes/core/doudian.shop.context.read.node.yaml --yes
pnpm bpa publish workflow workflows/examples/doudian.shop-context-observe.workflow.yaml --yes
```

构建扩展后，在 Chrome 的 `chrome://extensions` 开启开发者模式，加载：

```text
apps/extension/.output/chrome-mv3
```

固定扩展 ID 为 `hoobbnlkcdhbemedpfhhoicklplggmbc`。Native Host 只允许该 Origin。

打开并登录：

```text
https://fxg.jinritemai.com/ffa/g/list
```

执行：

```bash
pnpm bpa run doudian.shop-context-observe --version 1.0.0
pnpm bpa inspect <run-id>
pnpm bpa events <run-id>
pnpm bpa audit
```

首个节点仅读取当前店铺 ID、名称、URL、TabRef 和 PageEpoch，不执行保存、发布、改价或其他写操作。

## 3. MCP / Codex 创作服务

启动命令：

```bash
pnpm mcp
```

服务暴露：

- `catalog_search`
- `workflow_gen`
- `workflow_validate`
- `workflow_simulate`
- `artifact_diff`
- `node_gen`
- `node_requirement_create`

所有生成工具只能调用 `asset.candidate`。它们不能批准或发布；发布仍必须由人在 CLI 使用 `--yes` 完成。

## 4. 安装、升级与回滚

发布包携带经过 SHA-256 校验的 Node.js 24 macOS arm64 Runtime。

```bash
./scripts/install-macos-arm64.sh
./scripts/rollback-macos.sh
./scripts/uninstall-macos.sh
./scripts/uninstall-macos.sh --purge-data
```

安装器先在旧版本仍运行时完成新 Runtime 和 SQLite Migration；只有全部成功才原子切换 `runtime/current`。上一版本保存在 `runtime/previous`。应用回滚不倒退数据库 Migration。

默认卸载保留：

```text
~/Library/Application Support/BPA/data
```

只有显式 `--purge-data` 才删除业务数据。

## 5. 故障判定

- `doctor.browser.connected=false`：检查 Chrome 是否加载扩展、Native Host Manifest 路径和扩展固定 ID。
- `browser.ready=false`：扩展已连接但尚未报告兼容 Capability。
- `waiting_browser`：命令尚未获得最终 Result；断线后会按 Command Sequence 重放。
- `uncertain`：系统无法证明写动作是否生效，必须人工核验，不能自动假定失败并重做。
- `SCHEMA_INVALID`、`SIGNING_KEY_MISMATCH`、`GRANT_*`：协议或授权校验失败；Bridge 不执行节点。

Core 私钥位于数据目录，权限固定为 `0600`。扩展只接收 Ed25519 公钥。
