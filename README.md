# BPA

[![CI](https://github.com/MapleCity1314/BPA/actions/workflows/ci.yml/badge.svg)](https://github.com/MapleCity1314/BPA/actions/workflows/ci.yml)
[![Protocol Docs](https://github.com/MapleCity1314/BPA/actions/workflows/docs-pages.yml/badge.svg)](https://github.com/MapleCity1314/BPA/actions/workflows/docs-pages.yml)

![BPA：真实浏览器中的受约束执行](.github/assets/readme-hero.svg)

<p align="center">
  <a href="https://maplecity1314.github.io/BPA/">协议文档</a>
  ·
  <a href="docs/BPA通用技术方案-v1.0.md">架构方案</a>
  ·
  <a href="docs/local-v1-operations.md">运行与验收</a>
  ·
  <a href="https://maplecity1314.github.io/BPA/reference/schemas/">JSON Schema</a>
</p>

BPA（Browser Process Assistance）把经过审核的浏览器流程编译成版本化 Workflow 和 Node，再交给用户真实浏览器中的扩展执行。人和 AI 可以触发同一套流程，但 AI 不直接接管浏览器，也不能在运行时下发任意 JavaScript。

当前仓库包含一条可运行的本地纵向链路：CLI、Local Core、Workflow Engine、Browser Gateway、Native Host、Chrome Extension、SQLite 状态与审计，以及用于创作 Workflow / Node 的 MCP 工具。

2026-07-30 的实现实况见 [BPA 0.4 当前实况](docs/current-state-v0.4.md)。上一阶段的默认节点和 Skills 盘点保留在 [BPA 当前实况与默认资产 v0.3](docs/current-state-and-default-assets-v0.3.md)；单节点运行、人工步骤、结构化循环和 AI 页面预定位设计见 [BPA 基础场景、工程闭环与 AI 创作设计 v0.4](docs/basic-scenarios-and-ai-authoring-v0.4.md)。

## 执行边界

```text
Human / AI
    │  structured request
    ▼
Workflow Compiler ──→ Workflow Engine ──→ Browser Gateway
                                              ⇅  bpa.browser/1
                                      Extension Bridge
                                              │
                                              ▼
                                     Real Browser DOM

Every step ──→ Event Log · Evidence · Audit · Human Approval
```

Workflow 决定流程，Node 定义单步能力，Extension Bridge 校验页面上下文和权限后执行动作。页面内容只是输入，不能变成系统指令。写动作的结果无法确认时，运行进入 `uncertain`，不会把未知副作用当作失败后自动重试。

这不是通用浏览器 Agent，也不以 headless 浏览器代替用户环境。当前实现首先解决真实登录态下的确定性执行、断线恢复、权限收敛和证据留存。

## 当前版本

| 范围 | 版本 / 状态 | 说明 |
| --- | --- | --- |
| BPA Runtime | `0.3.0` + `0.4` candidate | 已进入可信 Evidence、资源绑定和本地业务工作台迭代，正式 0.4 RC 尚未发布 |
| Browser Protocol | `bpa.browser/1` · `1.0.0` | 已确认；双向独立序列、ACK、Resume、Cancel 与 Fencing |
| Permission / Event / Evidence | `v1` | 稳定公共模型 |
| Workflow / Node | Workflow `v1alpha1` / `v1alpha2` / `v1alpha3`；Node `v1alpha1` / `v1alpha2` | Alpha；v1alpha3 增加冻结 Browser Resource Slot |
| Reference Adapter | Doudian Adapter `1.2.0` | 当前只读参考场景，不代表通用零适配承诺 |

机器规范以 [`packages/schemas/schema`](packages/schemas/schema) 为唯一事实来源。公开站点只复制明确列入白名单的 Schema 和中性消息样例。

## 仓库结构

```text
.
├── apps/
│   ├── cli/                 # 本地控制 CLI
│   ├── console-host/        # Loopback 工作台 Host 与安全文件通道
│   ├── docs/                # Astro + Starlight 协议站
│   ├── extension/           # WXT Chrome Extension
│   ├── local-core/          # 本地控制面与 Unix Socket API
│   ├── mcp-server/          # Workflow / Node 创作工具
│   ├── native-host/         # Chrome Native Messaging Host
│   └── operator-console/    # React 本地业务工作台
├── packages/
│   ├── compiler/            # Workflow 编译、摘要与版本固定
│   ├── engine/              # 执行、重试、暂停、取消与补偿
│   ├── gateway-core/        # Browser Protocol 会话与投递
│   ├── browser-bridge/      # Bridge 端协议、Pending Result
│   ├── node-runtime/        # Node 执行契约
│   ├── asset-core/          # 不可变 Asset / Blob 契约
│   ├── asset-store-local/   # 本地 SHA-256 内容寻址存储
│   ├── evidence-core/       # Evidence 生命周期与分块语义
│   ├── persistence/         # 持久化接口
│   ├── persistence-sqlite/  # SQLite Registry / Event / Inbox / Outbox
│   └── schemas/             # JSON Schema 与生成类型
├── adapters/doudian/        # 首个真实页面适配器
├── nodes/core/              # 内置控制与数据节点
├── workflows/examples/      # 可发布 Workflow 样例
├── skills/                  # BPA 创作与诊断 Skills
├── docs/                    # 架构、协议、运维和实验记录
└── scripts/                 # 安装、升级、回滚与卸载
```

## 开始开发

要求 Node.js 24 LTS 和 pnpm 10.32.1。

```bash
git clone https://github.com/MapleCity1314/BPA.git
cd BPA
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 是本地、CI 和打包前的统一门禁，覆盖仓库资产一致性、脚本语法、
Schema、类型、测试、构建和文档检查。

启动 Local Core，并在另一个终端检查状态：

```bash
pnpm core
pnpm bpa doctor
```

启动协议文档：

```bash
pnpm docs:dev
```

Chrome 扩展、Native Host、首个只读 Workflow 和 macOS 安装流程见[本地 v1 运行与验收](docs/local-v1-operations.md)。

## 从资产到执行

Published Artifact 不能用相同的 `asset_id + version` 覆盖。候选资产可以由 MCP 工具生成或校验，但正式发布必须由人在 CLI 中明确确认。

```bash
# 校验
pnpm bpa validate node nodes/core/control.start.node.yaml

# 发布
pnpm bpa publish node nodes/core/control.start.node.yaml --yes

# 执行
pnpm bpa run <workflow-id> --version <version>
pnpm bpa inspect <run-id>
pnpm bpa events <run-id>
```

MCP 服务提供 `catalog_search`、`workflow_gen`、`workflow_validate`、`workflow_simulate`、`artifact_diff`、`node_gen` 和 `node_requirement_create`：

```bash
pnpm mcp
```

这些工具只能创建 `asset.candidate`，不能代替人工批准发布。

## 协议与安全

Browser Protocol v1 覆盖会话建立、能力声明、Permission Grant、命令投递、结果确认、断线恢复、取消与 Fencing。协议对未知字段严格失败，Extension Bridge 会拒绝过期权限、错误序列、无效签名和不匹配的页面上下文。

- [Browser Protocol v1](https://maplecity1314.github.io/BPA/browser/v1/)
- [消息类型与信封](https://maplecity1314.github.io/BPA/browser/v1/messages/)
- [安全边界](https://maplecity1314.github.io/BPA/browser/v1/security/)
- [Timing 与 Risk](https://maplecity1314.github.io/BPA/browser/v1/timing-and-risk/)
- [公共模型与 Schema](https://maplecity1314.github.io/BPA/reference/schemas/)
- [规范消息样例](https://maplecity1314.github.io/BPA/reference/examples/)

## 项目阶段

BPA 已完成本地 v1 的纵向闭环和一个真实页面的只读参考实现。现阶段重点是收紧协议与资产模型、扩大回放和故障测试，再逐步抽离更多通用节点。仓库中的 `docs/architecture-v0.1.md` 和实验报告用于追溯，不是当前规范。

架构基线以 [BPA 通用技术方案 v1.0](docs/BPA通用技术方案-v1.0.md) 为准；对外集成优先阅读[协议文档站](https://maplecity1314.github.io/BPA/)。

## License

仓库目前尚未选择开源许可证。在 `LICENSE` 文件落地前，源码可公开阅读，但不自动授予复制、修改或再分发权利。
