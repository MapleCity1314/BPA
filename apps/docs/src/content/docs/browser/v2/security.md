---
title: 安全边界
description: Permission Grant、Ed25519、Fencing Token 与不可信页面输入的约束。
---

Browser Protocol 把页面视为不可信输入。Bridge 不接受页面、Content Script 或远程调用方自报权限。

## Permission Grant 是完整权限快照

每个 Command 内嵌当前节点的最小权限快照，包括：

- 权限集合与允许的域名。
- 风险等级与有效期。
- Run、Node Execution、Node 版本和 Fencing Token。
- 签名密钥标识、Grant 摘要与授权签名。

Core 对规范化 JSON 计算 SHA-256 `grant_digest`，再使用 Ed25519 私钥生成 `authorization_tag`。`session.welcome` 下发当前公钥、算法和 `key_id`。

Bridge 必须同时验证摘要、签名、有效期、域名、风险等级、节点版本和 Command 绑定。任一字段变化都必须拒绝，不能降级为“仅引用可信”。

## Fencing 防止旧执行推进状态

Command、ACK、Result 和 Cancel 都绑定当前 `fencing_token`。旧 Token 的结果可以保留为审计记录，但不能推进 Workflow。

Fencing 解决的是过期执行者问题，不代替幂等键，也不证明页面动作未发生。

## 页面验证发生在动作之前

Bridge 在执行前重新检查：

1. Deadline 是否仍有剩余时间。
2. 冻结的确切 Tab、Origin、Observation Revision 与 Page Epoch 是否匹配。
3. Permission Grant 是否覆盖目标域名和动作。
4. 页面是否稳定，是否出现验证码、登录或风险控制。
5. Timing Policy 的等待是否会越过 Deadline。

Blocking Risk Signal 必须停止动作并返回 `rejected`。协议不允许尝试绕过验证码、登录、二次认证或平台风控。

对于 Workflow v1alpha3，Gateway 还会核对 Command 所需的精确 Browser Instance、
Tab、Capability Digest、Origin/path、认证上下文、Observation Revision 与 Page Epoch。
任一事实与冻结 Binding Snapshot 不一致时，Command 不会被派发到当前活动页或其他
“看起来可用”的 Session。

## Evidence 与业务结果分离

普通 Result 只携带结构化输出和 `evidence_refs`。截图、文件或较大的验证材料通过 Evidence 分块传输，正文与 Metadata 分开保存。

Evidence 在完整 ACK 前保留在 Bridge 本地；Result 在 Result ACK 前保留。Core 只有
在 Evidence 已持久化、所有权与当前执行一致时才接受引用。

Console 文件使用另一条受限本机 Staging 通道。控制面只携带一次性租约和不可变上传
回执，不接收浏览器提交的最终路径。
