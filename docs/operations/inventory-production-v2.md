# 库存生产链路 V2 运行说明

## 唯一生产入口

`com.bpa.inventory-multishop-recovery` 每 30 分钟启动一次
`apps/inventory-monitor/src/production-cycle.ts`。Codex、旧 scheduler 和内部刷新脚本
都不是生产控制面。飞书库存通知在本阶段保持关闭。

## 固定生产目录

| 类型 | 固定目录 |
| --- | --- |
| 应用代码 | `/Users/yyerybz/Codex/BPA` |
| 运行状态 | `~/Library/Application Support/BPA` |
| PostgreSQL 备份 | `~/Library/Application Support/BPA/backups/postgres/{daily,weekly}` |
| Core 快照 | `~/Library/Application Support/BPA/backups/core` |
| 部署归档 | `~/Library/Application Support/BPA/backups/deploy` |
| 加密离机副本 | `~/Library/Mobile Documents/com~apple~CloudDocs/BPA/Backups/PostgreSQL` |

生产启动器通过 `production-layout.sh` 校验上述目录，偏离时安全失败。用户主目录
不得直接存放 BPA 应用副本、扩展构建或备份目录。

## 组件边界

每店依次记录四个独立组件结果：

1. `canary`：验证 Browser Instance、登录、店铺、商品页角色、结构稳定和未知弹窗。
2. `orders`：120 分钟内的近期订单事实直接复用；过期时先读取浏览器，订单量超过
   浏览器节点上限或读取失败时改用 WDT 热数据镜像。
3. `inventory`：逐商品即时持久化并返回 complete / partial / blocked 批次摘要。
4. `risk`：只消费已持久化且仍有效的库存和订单事实，可独立补算。

订单刷新失败只把订单组件标为 `degraded`，不丢弃已成功的库存快照。单商品失败
形成 `partial`，保留覆盖率、阶段、错误码和 Evidence / Run ID；只有没有任何可用
库存事实时才把该店标为 `blocked`。

## 并发和恢复

- PostgreSQL `ops.lease` 防止两个生产周期重叠。
- Core `browser_control_leases` 防止两个 BPA 控制者操作同一 Browser Instance。
- 两类租约都使用 fencing token，并在运行中定时续约。
- 每轮、每店、每组件状态持久化在 `ops.collection_run` 和
  `ops.collection_step`，进程退出不再依赖日志推断结果。
- 标签页仍由专用 Chrome Profile 与固定 CDP 端口物理隔离；只回收工作流创建的
  商品页和订单页。

## 诊断与安全停止

登录失效、验证码、店铺不匹配、未知弹窗、结构变化和控制租约丢失都会安全停止，
不会自动绕过。脱敏诊断写入：

`$BPA_RUNTIME_ROOT/diagnostics/inventory/<collection-run>/`

文件权限为 `0600`，只包含组件、退出码、时间和截断后的错误，不包含个人信息、
订单 JSON 或数据库凭证。

## 2026-08-05 首轮生产验收

- 运行 ID：`collection:2026-08-05T09:47:42.443Z:3ebf819c-e9f0-427f-a2f2-d86de2855d54`。
- 13 家店铺全部通过金丝雀并完成库存采集，319 / 319 个商品持久化，覆盖率 100%。
- 13 家店铺全部完成风险计算；12 家复用 120 分钟内的近期订单事实。
- 榆园儿食品专营店的近期订单读取失败，订单组件记为 `degraded`，但该店 86 / 86
  个商品库存和风险计算仍正常完成，证明组件已解耦。
- 运行终态为 `degraded`，退出码为 0；通知投递为 `disabled`。
- PostgreSQL 与 Browser Control Lease 均已释放，launchd 保留 1800 秒周期入口。
- 面板返回 13 家、319 个商品、777 个 SKU，全部商品快照处于 2 小时有效期内。

当前尚需积累至少 3 天渠道历史，渠道冷启动结果继续作为数据质量状态，不生成
确定性开放风险。部分店铺 P90 回测覆盖率尚未达到 85%–95% 放行区间，属于模型
校准项，不影响库存事实采集和页面可用性。

## 2026-08-05 无人值守与高销量店验收

- launchd 在 18:47:10 无人工调用创建第二轮 `schedule` 运行，证明生产不依赖
  Codex；13 / 13 家库存、13 个金丝雀和 13 个风险组件全部完成。
- 第二轮持久化 319 个商品、746 个 SKU 快照行和 2,123 个渠道库存行；库存覆盖率
  100%，PostgreSQL 与 Browser Control Lease 在结束后均无有效残留。
- 11 家浏览器订单刷新成功、1 家复用新鲜事实。榆园儿 90 分钟订单量超过 500 条
  时，浏览器节点按安全上限拒绝，错误码为
  `RECENT_ORDER_RESULT_LIMIT_EXCEEDED`，未发生截断写入。
- 生产周期现已在该错误后调用 WDT 确定性降级通道。实测同步 939 条增量订单，
  919 条新增、18 条更新，近期覆盖恢复到 19:01。
- 随后的单店恢复轮在新订单版本之后重采 86 / 86 个商品并重算风险，终态
  `succeeded`；面板显示 3 个真实严重风险，均为 SKU 库存无法覆盖未来 2 小时
  P90 需求（可用库存分别为 0、0、2）。
- 飞书库存日报和中途提醒仍保持 launchd disabled；生产摘要中的通知投递继续为
  `disabled`。

## 2026-08-05 备份目录与任务验收

- 23 个用户目录根级扩展构建以 move-only 方式归档到
  `backups/deploy/extension/legacy-20260803`，没有删除历史内容。
- 原有 PostgreSQL 日备份、周备份和 6 个加密离机副本全部迁入固定分层目录。
- 备份任务使用防重入锁、临时 dump、`pg_restore --list` 校验、原子发布、
  SHA-256 和唯一时间戳 age 加密副本；本地执行 14 日、8 周保留策略。
- 最终 launchd 验收为 `runs=1`、`last exit code=0`，工作目录固定且启用低优先级
  I/O。最新 dump 为 334,815,518 字节，SHA-256 校验通过，restore list 包含
  103 个条目，离机加密副本为 334,897,446 字节。
- 所有生产目录权限为 `0700`、备份文件为 `0600`，无 `.partial` 文件和残留锁。
