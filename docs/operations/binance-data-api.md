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

服务不发送 wildcard CORS。所有路由只允许 GET/HEAD，响应使用 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。

## 状态语义

- `GET /healthz`：仅证明进程存活。
- `GET /readyz`：证明配置、SQLite 可读和 schema v26 可用。始终以 HTTP 200 返回 `ready` 布尔值，避免因业务数据状态触发守护进程重启环。
- `GET /api/v1/binance/readiness`：业务数据是否新鲜、完整、可供下游读取。无数据、过期、部分采集和登录失效分别表达。

## v1 路由

- `/api/v1/binance/overview`
- `/api/v1/binance/runs`
- `/api/v1/binance/projects`
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
