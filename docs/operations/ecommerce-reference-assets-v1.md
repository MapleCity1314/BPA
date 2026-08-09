# 三平台参考图片证据包操作说明 v1

> 文档类别：操作说明。当前实现为未部署候选；本文件不构成来源授权或生产许可。

## 1. 产品边界

正式入口是 `ecommerce.cross-platform-evidence-probe@2.0.0`。它只读取操作者已经打开、
关键词一致的抖音、淘宝和京东商品搜索页，不翻页、不登录、不绕过验证码或风控。

输出始终是内部参考包：

- `rightsStatus = not_assessed`
- `allowedUse = internal_reference_only`
- `blockers = [SOURCE_RIGHTS_NOT_ASSESSED]`

公开可访问、已进入 CAS 或可以预览，都不等于取得版权、商标或再分发授权。

## 2. 运行前检查

1. 三个平台各保留一个明确的搜索结果页，页面关键词与 Workflow 输入逐字一致。
2. 使用同一个受管 Browser Instance；任一页面出现登录失效、验证码、频控或风控即停止。
3. 确认本轮 `packId` 唯一，候选最多 20 张，单图不得超过 5 MiB。
4. 不在 Workflow 输入中提供 Run ID、Evidence ID、Cookie、本地文件路径或下载凭据。
5. 未获得明确 Page Binding 与人工操作许可时，只运行 fixture/本地测试，不访问真实页面。

## 3. 人工策展

物化完成后 Workflow 会进入阻塞式 `reference_asset_curation@1.0.0`：

- Operator Console 任务中心直接显示本轮 CAS 候选缩略图；不需要复制 Asset ID、Run ID 或文件路径；
- 每张采用图片必须选择一个角色；
- 必须填写采用理由和至少一条禁止推断；允许迁移维度由 Core 根据受控角色映射生成，客户端不能自填；
- 采用与拒绝集合必须完整覆盖所有物化候选，不允许遗漏或重复；
- 角色只说明设计用途，不得推断销量、转化、版权、授权或产品真实性。

人工任务未完成、输出不完整或物化回执与当前 Run 不一致时，参考包不会发布。

## 4. 安全预览与下载

策展阶段的候选缩略图在“任务中心”显示；发布后的受限缩略图与 ZIP 位于“报告与参考资产包”。
预览与下载只在本机 Operator 会话开放；Viewer 返回 403。Console Host 不通过 512 KiB
Control 协议接收图片正文，而是根据 Core 的受控清单从同一 BPA CAS 读取，并逐项复核
平台 CDN、页面来源、5 MiB 上限、size 与 SHA-256。

ZIP 包包含 `manifest.json` 与 `assets/`：manifest 保留来源、角色、允许迁移维度、禁止推断和
权利阻断。不得删除 manifest 后单独外发图片。

## 5. 立即停止线

- Browser Evidence 与当前 Run、平台、商品、页面或图片 URL 不一致；
- 图片重定向离开受控 CDN、响应类型异常、超过 5 MiB 或摘要不一致；
- CAPTCHA、SESSION_EXPIRED、RATE_LIMITED 或 RISK_CONTROL；
- 人工策展请求把权利状态改为“已授权”或要求外发；
- CAS 文件缺失、大小/摘要不一致、Export 回执不存在或跨 Run；
- 出现第二个受管 Browser Instance、页面绑定漂移或任一未解释的自动重试。

发生停止线后保留现有 Evidence/Attention，只观察并给出一个精确人工动作；不重复下载、
不换 URL 规避、不把失败候选写成成功参考包。

## 6. 当前验证边界

本地 Node 24 测试已经覆盖 Runtime Evidence checkpoint 绑定、三平台 fixture、CAS 物化、
人工确认、Export、ZIP、预览权限与摘要反例。真实登录 Chrome、真实 CDN、真实平台风控、
来源权利和生产部署均待确认；正式灰度前需重新只读 preflight。
