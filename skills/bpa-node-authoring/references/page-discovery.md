# 页面发现与元素契约

页面发现只服务于 Browser Node / Adapter 创作。正常 Workflow 只引用语义 Node，
不得携带选择器、坐标、任意脚本或 DOM 查询。

## 安全发现会话

在仓库支持 AuthoringSession 后，必须满足：

1. 用户显式开启 Design Mode，并看到绑定的 profile、tab、Origin 和剩余时间。
2. 会话固定在精确 Origin，默认只读，TTL 到期自动关闭。
3. 不提供通用 evaluate、远程脚本或任意 JavaScript。
4. DOM 在扩展侧裁剪、限量和脱敏；密码、token、cookie、隐藏输入和个人信息不上传。
5. 页面导航、快照、候选生成和人工确认都写入 Audit。

在 Design Mode 尚未由用户对真实页面授权时，只使用脱敏静态夹具、replay 或人工
提供的最小 DOM 片段；不得把普通 Browser Command 当发现接口。

## 发现步骤

1. 确认页面身份：Origin、路由、frame、账号/店铺上下文和稳定页面状态。
2. 只截取与目标能力有关的最小 DOM 子树和无障碍信息。
3. 按优先级收集多个候选：
   - 平台业务 ID 或已审核 `data-*`。
   - role + 稳定 accessible name。
   - label、name、href 语义和结构化属性。
   - 相对语义锚点。
   - CSS 只作诊断候选。
4. 声明期望数量、可见/可用状态、前置条件和写后断言。
5. 在多个脱敏状态和 replay 上验证唯一性、稳定性和页面恢复。
6. 保存 PageModel/ElementContract 候选、夹具和契约测试，交给人工审查。

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
