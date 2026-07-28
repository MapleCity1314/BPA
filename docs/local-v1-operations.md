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

## 2. 导入数据并准备只读 Workflow

Published Artifact 不允许用相同 `asset_id + version` 覆盖。以下动作会写入 Audit：

```bash
for node in nodes/core/*.node.yaml; do
  pnpm bpa publish node "$node" --yes
done
pnpm bpa publish adapter adapters/doudian/doudian.adapter.yaml --yes
pnpm bpa publish policy policies/core/packaging_match_review.validator.policy.json --yes
pnpm bpa publish assistance_profile assistance-profiles/core/packaging_match_review.assistance-profile.json --yes
pnpm bpa publish assistance_profile assistance-profiles/core/binding_confirm.assistance-profile.yaml --yes
pnpm bpa publish workflow workflows/examples/doudian.shop-context-observe.workflow.yaml --yes
pnpm bpa publish workflow workflows/examples/doudian.priority-items-readonly-inspect.workflow.yaml --yes
```

上述命令只是发布顺序示例。正式资产发布属于人工安全门，Codex 不会代替用户执行。

先导入不可变包装主数据：

```bash
pnpm bpa dataset import /absolute/path/to/包装主数据.xlsx \
  --id packaging-master \
  --version 2026.07.28 \
  --yes
pnpm bpa dataset inspect packaging-master --version 2026.07.28
```

构建扩展后，在 Chrome 的 `chrome://extensions` 开启开发者模式，加载：

```text
apps/extension/.output/chrome-mv3
```

固定扩展 ID 为 `hoobbnlkcdhbemedpfhhoicklplggmbc`。Native Host 只允许该 Origin。
正式安装包将扩展复制到物理稳定路径：

```text
~/Library/Application Support/BPA/extension
```

首次安装从该目录“加载已解压的扩展程序”。以后升级会原子替换目录内容并保留失败回滚，
Chrome 中只需点击“重新加载”；不要加载 `runtime/<version>` 下的版本化目录。

打开并登录：

```text
https://fxg.jinritemai.com/ffa/g/list
```

执行：

```bash
pnpm bpa run doudian.shop-context-observe --version 1.2.0
pnpm bpa run doudian.priority-items-readonly-inspect \
  --version 0.2.0 \
  --input '{"dataset":{"id":"packaging-master","version":"2026.07.28"},"platformFillCheck":false}'
pnpm bpa inspect <run-id>
pnpm bpa events <run-id>
pnpm bpa audit
```

完整 Workflow 会读取范围、逐商品导航和检查，但不修改表单、不保存、不发布、不改价。
包装未匹配不会阻止基础检查，也不会被计为商品问题。

该节点已启用有界调度抖动、自适应页面稳定性等待和 Tab 级最小操作间隔。
因此 Run 进入 `waiting_browser` 后可能短暂停留在持久化延迟 Outbox，这是正常状态。
`NODE_SCHEDULED` Event 会记录实际 `delayMs` 和解析后的 TimingPolicy。

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
当前版本为 BPA Runtime `0.3.0`、Doudian Adapter `1.1.0`、重点项只读 Workflow `0.2.0`。
旧 Runtime 与已发布资产继续保留，不执行覆盖升级。

```bash
BPA_BUNDLED_NODE=/absolute/path/to/node24 \
  ./scripts/package-macos-arm64.sh
tar -xzf artifacts/bpa-local-v0.3.0-macos-arm64.tar.gz
cd bpa
./install.sh
./rollback.sh
./uninstall.sh
./uninstall.sh --purge-data
```

安装包是生产 allowlist 闭包，不含源码、测试、Skills、开发依赖、缓存或用户文件。
逐文件 Manifest、包级 SHA-256、SBOM、Node 版本、平台、原生 ABI 和包体预算均在切换前检查。

停止旧 Core 后，安装器执行 WAL checkpoint 和完整性检查，保存升级前快照，在数据库
副本上先跑 Migration；成功后才迁移业务库并原子切换 Runtime/Extension。切换后自动
检查 Core、Persistence、Socket 和安装文件。健康检查失败且没有新业务写入时恢复快照；
检测到新写入则拒绝破坏性回滚并保留现场。手工回滚不会执行 down migration。

默认卸载移除 Runtime、Native Host 和稳定扩展目录，但保留：

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
- `CAPTCHA_REQUIRED`、`RISK_CONTROL`、`SESSION_EXPIRED`：自动执行已阻断，恢复页面后重新发起；系统不会自动绕过。
- `RATE_LIMITED`：平台或本地节奏策略拒绝了当前执行；检查 Event 中的风险信号和建议等待时间。
- `PAGE_CONTEXT_CHANGED`：等待期间活动 Tab 或 URL 变化；重新切回目标页面后创建新 Run。

Core 私钥位于数据目录，权限固定为 `0600`。扩展只接收 Ed25519 公钥。
