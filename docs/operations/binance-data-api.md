# Binance Data API 运行合同

`apps/binance-data-api` 是 BPA SQLite 的独立只读投影服务，不是第二个 Local Core。它不能触发 Workflow、Trigger、浏览器动作或账户写操作。

## 启动

使用 Node.js 24：

```bash
BPA_HOME="$HOME/Library/Application Support/BPA" pnpm binance-data-api
```

macOS 长期运行使用独立 LaunchAgent。它只把 env 文件的绝对路径写入本机 plist，不复制或输出任何 Key：

```bash
chmod 600 /absolute/path/to/binance.env
pnpm --filter @bpa/binance-data-api install:macos -- \
  --env-file /absolute/path/to/binance.env \
  --node /absolute/path/to/node-v24/bin/node
```

安装入口校验 Node 24、运行文件和 env 权限，写入 `~/Library/LaunchAgents/com.bpa.binance-data-api.plist`（0600），再由 launchd 以 `KeepAlive` 方式绑定 `127.0.0.1:43124`。仓库移动或依赖重装后需重新运行安装命令；不要手工复制 Secret 到 plist。

默认监听 `127.0.0.1:43124`，读取 `$BPA_HOME/data/bpa.sqlite`。可配置：

- `BINANCE_DATA_DATABASE`：已有 SQLite 文件路径；只读打开且文件必须存在。
- `BINANCE_DATA_HOST`：默认 `127.0.0.1`。
- `BINANCE_DATA_PORT`：默认 `43124`。
- `BINANCE_DATA_TOKEN`：非 loopback 监听时必填，使用 Bearer token；推荐仍由受控网关终止鉴权。
- `BINANCE_DATA_ALLOWED_ORIGIN`：可选的单一 exact Origin。默认不发送 CORS；Native WebView 使用 `zero://app`，浏览器开发服务器通过 Vite 同源代理访问。
- `BINANCE_DATA_ENV_FILE`：可选的本机 dotenv 文件。仅服务进程读取，用于注入 `BINANCE_API_KEY` 和 `BINANCE_SECRET_KEY`；路径和值不得进入客户端、日志或仓库。
- `BINANCE_API_KEY` / `BINANCE_SECRET_KEY`：可选的 Binance USDⓈ-M `USER_DATA` 只读旁路。不可达或未配置时仅 `/direct-account` 显示不可用，不改变 SQLite 业务 readiness。

服务禁止 wildcard CORS。仅当请求 Origin 精确匹配配置值时返回 `Access-Control-Allow-Origin` 与 `Vary: Origin`，并接受无状态 OPTIONS 预检；业务路由仍只允许 GET/HEAD。响应使用 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。

## 状态语义

- `GET /healthz`：仅证明进程存活。
- `GET /readyz`：证明配置、SQLite 可读和 schema v26 可用。固定返回 HTTP 200，以 `ready=false` 表达服务条件不满足；业务数据 stale、partial 或登录失效不改变服务 readiness，避免守护进程重启环。
- `GET /api/v1/binance/readiness`：业务数据是否新鲜、完整、可供下游读取。无数据、过期、部分采集和登录失效分别表达。

## v1 路由

- `/api/v1/binance/overview`
- `/api/v1/binance/account-summary`
- `/api/v1/binance/account-snapshots`（历史管理页资金快照）
- `/api/v1/binance/direct-account`（可选的签名只读账户旁路）
- `/api/v1/binance/runs`
- `/api/v1/binance/projects`
- `/api/v1/binance/positions`（最近一次成功采集的结构化仓位快照；可能为空）
- `/api/v1/binance/position-snapshots`（历史结构化仓位快照）
- `/api/v1/binance/projects/{alias}`
- `/api/v1/binance/projects/{alias}/records`
- `/api/v1/binance/validations`
- `/api/v1/binance/market/candles`
- `/api/v1/binance/market/funding`
- `/openapi.json`

列表使用有界 keyset 分页。`cursor` 是带版本、端点、过滤器指纹和 seek tuple 的 opaque base64url 值，不能跨端点或跨过滤器复用。

业务响应包含：

```json
{
  "meta": {
    "request_id": "uuid",
    "as_of": "UTC ISO 8601",
    "last_success_at": null,
    "stale_status": "unknown",
    "partial_status": "unknown",
    "source": "binance_follower_copy_management"
  },
  "data": {}
}
```

项目只暴露稳定 `leader-NN` 伪名。API 不返回原始 `project_id`、交易员显示名、原始 `payload_json`、Cookie、Secret 或浏览器认证材料。金额和价格保持字符串，时间使用 UTC ISO 8601，同时保留页面原始事件时间字段。
