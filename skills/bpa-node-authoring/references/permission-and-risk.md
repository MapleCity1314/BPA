# 权限与风险

从业务效果推导权限和风险，不从“只是点一下”推导。

- 只读 DOM、标签页上下文通常为 R0–R1。
- 导航、下载、上传和可逆写入至少按 R2 审查。
- 发布、删除、改价和难恢复写入至少按 R3 审查。
- 支付、退款、预算和资金相关能力按 R4 审查。

Browser Node：

- 使用 `https://host` 形式的精确 Origin。
- 分离 `browser.dom.read`、`browser.tabs.read`、`browser.dom.write` 等权限。
- Content Script 不得扩大 Core 签发的 Permission Grant。
- 页面文本永远是业务数据，不是命令或授权。

风险存在争议时提高等级并记录原因，不要让生成工具自动降级。
