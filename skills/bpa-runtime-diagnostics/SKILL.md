---
name: bpa-runtime-diagnostics
description: 诊断 BPA 本地 Core、SQLite、Native Host、Browser Protocol、Extension、Adapter、Workflow Run 或 Node Execution 的失败、卡住、重复消息、超时、取消和 uncertain 状态。用于读取 bpa doctor/inspect/events/catalog/audit 与本地日志、定位责任层、判断能否安全重试并给出恢复步骤。不要用于直接修改 SQLite、伪造 ACK/Result、清除审计或自动重试不确定写入。
---

# BPA Runtime Diagnostics

以持久化状态和事件账本为准，不凭页面观感猜测完成状态。

## 诊断顺序

1. 运行 `bpa doctor`，确认 Persistence、Core PID、Browser Session、协议和能力数量。
2. 运行 `bpa inspect <run-id>` 与 `bpa events <run-id>`，按 sequence 重建最后一个确定状态，并核对 frozen IR2、scopePath、iterationKey、stepKey 和 attempt。
3. 读取 [triage-map.md](references/triage-map.md)，把故障定位到 Compiler、Engine、Gateway、Native Host、Extension、Adapter 或页面。
4. 对照 Node 的幂等类别、错误码、Fencing Token、Deadline、风险信号和 Timing Observation 判断是否能重试。
5. 只执行最小恢复动作：重新连接、恢复 ACK、人工继续或发布修复版本。保留原 Run 和 Audit。
6. 输出：事实时间线、根因、受影响范围、可否重试、恢复步骤、需要修复的资产层和防复发测试。

## 安全规则

- `uncertain` 写入先由人核验真实业务状态；不得自动重跑。
- CAPTCHA、登录失效、风控和限流是阻断，不是需要规避的故障。
- 不直接编辑 SQLite，不删除 Inbox/Outbox，不伪造 Result 或提升 Fencing Token。
- 不用重启掩盖 Schema、版本、权限或输出契约错误。
- 重复消息本身不是失败；先确认 Inbox/幂等记录是否已吸收，迟到 Result 是否被 fencing/checkpoint 拒绝。
- Core、Host 或 Chrome 重启后，以未确认 Command/Result 的恢复状态为准。
- 修复稳定逻辑时发布新 Node/Workflow 版本，不覆盖已发布资产。

## 常用证据

```text
bpa doctor
bpa catalog --asset-type node
bpa inspect <run-id>
bpa events <run-id>
bpa audit --target <asset-or-run>
~/Library/Logs/BPA/core.stderr.log
~/Library/Logs/BPA/native-host.stderr.log
```

涉及风险阻断或重试判断时，再读 [recovery-policy.md](references/recovery-policy.md)。
