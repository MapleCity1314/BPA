# 故障分层

| 信号 | 优先责任层 | 检查 |
|---|---|---|
| validate/compile 拒绝 | Schema / Compiler | 版本、风险、循环、未启用 runtime、输入输出 Schema |
| Run 停在 `waiting_browser` | Gateway / Host / Extension | Session ready、Capability、Command ACK、Deadline |
| Run 停在 `waiting_human` | Human | 当前 Node、审批输入、审批人决定 |
| `OUTPUT_SCHEMA_INVALID` | Node / Adapter | 实际 Result 与已发布输出契约 |
| `BINDING_RESOLUTION_FAILED` | Workflow | 仅使用 input/previous 精确绑定 |
| `STALE_FENCING_TOKEN` | Gateway / 重放 | 是否为旧执行权返回的迟到 Result |
| `CAPTCHA_REQUIRED` / `RISK_CONTROL` | 页面风险 | 停止并交还用户 |
| `RATE_LIMITED` | 节奏 / 页面 | Timing Observation、队列上限、平台提示 |
| `PAGE_CONTEXT_CHANGED` | Extension / 页面 | TabRef、PageEpoch、URL 与店铺上下文 |
| `uncertain` | 写入验证 | 人工核验真实状态，禁止自动重试 |

先找最后一个已提交事件，再检查后续消息；不要倒推或补写账本。
