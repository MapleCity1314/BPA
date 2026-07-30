# 页面发现与元素契约

页面发现只服务于 Browser Node / Adapter 创作。正常 Workflow 只引用语义 Node，
不得携带选择器、坐标、任意脚本或 DOM 查询。

## 安全发现会话

必须满足：

1. 用户显式开启 Design Mode，并看到绑定的 profile、tab、Origin 和剩余时间。
2. 会话固定在精确 Origin，默认只读，TTL 到期自动关闭。
3. 不提供通用 evaluate、远程脚本或任意 JavaScript。
4. DOM 在扩展侧裁剪、限量和脱敏；密码、token、cookie、隐藏输入和个人信息不上传。
5. 页面导航、快照、候选生成和人工确认都写入 Audit。

在 Design Mode 尚未由用户对真实页面授权时，只使用脱敏静态夹具、replay 或人工
提供的最小 DOM 片段；不得把普通 Browser Command 当发现接口。

## 发现步骤

1. 调用 `authoring_session_create` 固定 ScenarioSpec，再用 `catalog_search` 证明能力缺口。
2. 让用户在 BPA Console 对精确 Browser Session、Profile、Tab、Origin 和 PageEpoch
   授权；MCP 的 `design_mode_start` 只能核验，不能批准或扩大授权。
3. 用 `design_snapshot_capture` 对至少两个页面状态分别捕获。完成 Run 后再次调用同名
   工具，把已落盘 Evidence 固化为 PageSnapshot。
4. 用 `design_snapshot_query` 按 role/text 分页查询；每次最多 200 个语义节点，不要把
   整页内容塞进模型上下文。
5. 确认页面身份：Origin、路由、frame、账号/店铺上下文和稳定页面状态。
6. 按优先级收集多个候选：
   - 平台业务 ID 或已审核 `data-*`。
   - role + 稳定 accessible name。
   - label、name、href 语义和结构化属性。
   - 相对语义锚点。
   - CSS 只作诊断候选。
7. 声明期望数量、可见/可用状态、前置条件和写后断言。
8. 调用 `page_candidate_validate`，在所有快照上验证数量、作用域和至少一个非 CSS
   稳定策略；通过后再调用 `page_candidate_gen`。
9. 简单文本、存在性和安全属性读取使用声明式实现；分页、虚拟滚动、恢复和相对
   锚点只生成 Adapter Handler 骨架。
10. 用 `candidate_bundle_validate`、`candidate_bundle_save` 和
    `candidate_bundle_export` 形成不可变候选包。不要应用 `candidate.patch`。
11. 调用 `design_mode_stop`，保存 replay 和契约测试，交给人工审查。

默认拒绝绝对 XPath、深层 `nth-child`、屏幕坐标、单一易变文案和无页面身份约束
的选择器。

## 失败关闭

出现以下任一情况时，Node 应返回明确阻断错误，不得猜测点击：

- 页面身份、账号或店铺身份无法确认。
- 候选元素为零个或多个。
- 页面进入未知版本或关键 fingerprint 明显变化。
- 验证码、登录失效、风控或限流提示。
- 人工接管后 PageEpoch 已变化且未重新确认。
- 写操作没有可验证的前置或后置状态。

ElementContract 是 Adapter 的版本化资产。页面变化后应先更新夹具与契约测试，
再发布新的 Node/Adapter 版本；不能静默覆盖旧版本。

Core 会重新读取 CAS Evidence，并核对 Result、Origin、PageEpoch、快照整体摘要和每个
语义节点摘要。任何不一致都应视为证据失败，不要通过人工复制页面文本绕过。
