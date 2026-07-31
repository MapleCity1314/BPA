# BPA 桌面端发布安全门禁

> 文档类别：正式规范。

BPA 的可安装发布物必须由一个干净的、已提交的 Git checkout 构建。正式 RC 身份由以下不可变输入共同决定：

```text
v<runtimeVersion>-rc.<gitCommit 前 12 位>.node<Node.js 精确版本>
```

对应归档名必须精确为目标平台之一：

```text
bpa-local-v<runtimeVersion>-rc.<gitCommit 前 12 位>.node<Node.js 精确版本>-macos-arm64.tar.gz
bpa-local-v<runtimeVersion>-rc.<gitCommit 前 12 位>.node<Node.js 精确版本>-windows-x64.zip
```

Runtime Manifest v2 同时固定完整 Git commit、Runtime 版本、精确 Node.js 24 patch、`darwin`、`arm64`、数据库 Schema 版本、文件尺寸和 SHA-256。归档、Runtime `package.json`、Extension、SBOM 和内置 Node 身份必须全部一致。
Windows Manifest 使用 `win32`、`x64`，并额外固定 Windows Node、SQLite
原生模块和 Native Host SEA 可执行文件。

## 构建和验证

```zsh
export BPA_BUNDLED_NODE=/absolute/path/to/node-24-darwin-arm64
zsh scripts/package-macos-arm64.sh
zsh scripts/verify-package-macos-arm64.sh \
  artifacts/bpa-local-v<version>-rc.<commit12>.node24.18.0-macos-arm64.tar.gz
```

Windows x64 在 Windows runner 上原生构建：

```powershell
.\scripts\package-windows-x64.ps1
.\scripts\verify-package-windows-x64.ps1 `
  .\artifacts\bpa-local-v<version>-rc.<commit12>.node24.18.0-windows-x64.zip
```

macOS 也可生成 Windows 交叉构建候选，用于提前验证闭包、PE 架构和敏感内容；
Windows 正式 RC 必须再通过 Windows runner 的 Node、SQLite、Migration、Core 和
验包测试。

打包器只接受精确 RC 文件名，并拒绝覆盖已有归档或 checksum。验包器要求同名 `.sha256` sidecar，检查归档路径安全、生产闭包 allowlist、Manifest 摘要、版本一致性、内容级敏感信息、SQLite Migration、Core Socket/CLI 健康、独立 Team Worker 真实调用和 Extension。

CI 在 macOS arm64、仓库 `.nvmrc` 固定的精确 Node.js 24 patch 上重新执行完整打包和验包，并只上传已经通过相同门禁的 tar 与 checksum。Node patch 同时进入 RC identity；Runner、目标 Runtime 或 Manifest 任一版本漂移都会拒绝构建。Runner 若不是 `arm64` 会直接失败，避免生成原生 ABI 错误的 `better-sqlite3` 包。

Windows CI 在 Windows x64、Node.js 24 上执行相同仓库门禁，并实际加载 Windows
`better-sqlite3`、创建数据库、执行 Migration、验证 SEA Native Host 和 ZIP。
Windows 安装采用 `%LOCALAPPDATA%\BPA`、Named Pipe、HKCU Native Host 和
当前用户启动项，不要求管理员权限。

## 旧包隔离

`artifacts/bpa-local-v0.3.0-macos-arm64.tar.gz` 属于旧版、非不可变命名的历史产物。它不具备 Manifest v2、精确 RC 身份和必需 checksum，**不得安装**。

发布脚本不会删除或覆盖这个历史文件；验包和安装流程会通过文件名、checksum、Manifest Schema 及内置 verifier 明确拒绝它。需要发布时必须生成新的 commit 绑定 RC 包，不能重命名或补写 sidecar 冒充新包。

安装器使用 Manifest 中的 RC identity 作为版本目录。`BPA_INSTALL_VERSION` 如被设置，也必须与该 identity 精确一致，因此不同 commit 的同一 Runtime 版本不会互相覆盖。
