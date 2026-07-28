# 恢复策略

## 可以自动恢复

- 未投递的只读 Command。
- 已持久化但未 ACK 的只读 Result。
- 明确声明可重试且未超过次数的读取超时。
- Session 断开后可证明未执行的 queued Command。

## 必须人工介入

- CAPTCHA、二次认证、登录失效或平台风控。
- 已送达写操作但没有可验证结果。
- `non_repeatable` Node 中断。
- 人工审批拒绝或审批上下文已过期。
- 当前页面店铺、标签页或 PageEpoch 与授权不一致。

## 不能采用

- 删除执行事件后重跑。
- 手改 Node Execution 为 succeeded。
- 提升或复用旧 Fencing Token。
- 把错误 Result 改成符合 Schema 的假数据。
- 关闭限速、风险检测或 Permission Grant 校验。
