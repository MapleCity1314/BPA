# Binance Data API 运行合同

`apps/binance-data-api` 是 BPA SQLite 的独立只读投影服务，不是第二个 Local Core。它不能触发 Workflow、Trigger、浏览器动作或账户写操作。

## 启动

使用 Node.js 24.18.0：

```bash
BPA_HOME="$HOME/Library/Application Support/BPA" pnpm binance-data-api
```

默认监听 `127.0.0.1:43124`，读取 `$BPA_HOME/data/bpa.sqlite`。可配置：

- `BINANCE_DATA_DATABASE`：已有 SQLite 文件路径；只读打开且文件必须存在。
- `BINANCE_DATA_HOST`：默认 `127.0.0.1`。
- `BINANCE_DATA_PORT`：默认 `43124`。
- `BINANCE_DATA_TOKEN`：非 loopback 监听时必填，使用 Bearer token；推荐仍由受控网关终止鉴权。
- `BINANCE_DATA_ALLOWED_ORIGIN`：可选的单一 exact Origin。默认不发送 CORS；攀升本地开发可显式设为 `http://127.0.0.1:4173`。正式 Native Origin 待宿主确认。
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
