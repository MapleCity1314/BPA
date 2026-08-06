# BPA 工作台与页面绑定复盘 v0.1

> 文档类别：产品与平台工程复盘。
>
> 记录时间：2026-08-04
> 记录范围：BPA Operator Console、Design Mode、页面绑定、开发期浏览器采集和相关安全边界。
> 关联文档：[抖店库存浏览器工作流稳定性复盘 v0.1](./抖店库存浏览器工作流稳定性复盘-v0.1.md)

## 1. 结论

当前 BPA Operator Console 和 Design Mode 把过多平台内部概念暴露给业务用户和开发者，形成了明显的心智负担，却没有显著降低动态业务页面的开发与稳定化成本。

“确认使用当前页面”的首要作用应当是建立一个准确、稳定、可恢复的页面资源绑定，而不是要求用户完成一套复杂的安全审批。页面绑定、浏览器控制权、节点权限和高影响动作确认是四个不同问题，必须在模型和交互上拆开。

建议：

1. 从用户产品中删除 `Design Mode` 这一心智。
2. 保留必要的 Origin、凭据脱敏、风险阻断、权限和审计能力，但全部下沉到 Core、Extension 和 Node/Adapter 边界。
3. 将 Design Mode 的有效能力拆为 `Page Binding` 和仅开发者使用的 `Developer Capture`。
4. 把 Operator Console 降级为开发者诊断控制台，不再作为业务员工的主要入口。
5. 将浏览器独占、状态恢复、操作闭环、录制夹具、离线回放和部分成功提升为 BPA 系统级能力。

## 2. 当前实现事实

### 2.1 Operator Console 当前暴露的概念

当前工作台包含：

- 首页
- 任务
- 结果
- 自动化
- 系统诊断
- 创作模式
- 运行诊断
- 数据导入
- 证据血缘

常规和高级页面中继续出现 Workflow、Run ID、Browser Session、Dataset ID、版本、Evidence、Runtime、风险等级等平台术语。

Design Mode 当前要求用户提供或选择：

1. Authoring Session ID。
2. 页面能力 Profile。
3. Browser Session。
4. 一次性页面绑定 JSON。
5. 是否允许单次截图。
6. 15 分钟授权确认。

这些参数是内部协议输入，不是用户业务目标。

### 2.2 当前 Authoring 协议的能力边界

现有 Authoring 能力能够：

- 冻结 Scenario、Session revision 和风险上限。
- 绑定精确 Browser Session、Profile、Tab、Origin 和 PageEpoch。
- 采集脱敏语义页面快照。
- 校验 Evidence 摘要和来源。
- 生成不可自动执行、不可自动发布的 Candidate Bundle。
- 对简单文本、存在性和安全属性读取进行声明式 replay。

但现有协议也明确：分页、虚拟滚动、复杂就绪和页面恢复仍只能生成 Handler 骨架并要求人工实现。

抖店库存场景最昂贵的部分正是分页、列表滚动、抽屉、悬停浮层、虚拟列表、弹窗、恢复、RPA 干扰和标签页回收。因此 Design Mode 对当前核心开发成本的改善有限。

## 3. 核心概念纠正

### 3.1 页面绑定不是安全审批

页面绑定应回答：

- BPA 将使用哪个浏览器实例。
- 使用哪个 Profile、窗口和标签页。
- 当前是什么平台、店铺和页面类型。
- 页面是否在线、已登录并满足运行前提。
- 刷新、跳转或短暂掉线后如何恢复。

用户动作应简化为：

```text
绑定当前页面给 BPA
```

Extension 和 Core 自动完成页面识别、注册、心跳和状态维护。用户不应复制 JSON，也不应填写 Session、Profile 或 revision。

### 3.2 页面绑定、控制权、权限和确认必须分离

| 概念 | 回答的问题 | 负责层 | 用户是否参与 |
| --- | --- | --- | --- |
| Page Binding | 使用哪一个页面 | Extension + Core | 首次点击一次 |
| Control Lease | 当前谁可以操作页面 | Core + 跨 RPA 协调 | 自动 |
| Capability / Permission | 节点可以读写什么 | Node + Adapter + Runtime | 已发布能力固定 |
| Effect Confirmation | 是否允许产生高影响外部结果 | Task + Interaction Policy | 真正需要时确认 |

把四者合成一次 Design Mode Grant，会同时增加用户负担和系统耦合。

## 4. 当前安全设计的方向错配

### 4.1 投入较多的威胁

当前 Authoring 体系重点处理：

- 页面文本影响模型指令。
- 候选文件自动进入源码目录。
- 候选资产自动执行或发布。
- CAS revision 冲突。
- Snapshot 和 Evidence 摘要不一致。
- 单次截图未经额外批准。
- 15 分钟 Grant 超期。
- PageEpoch 发生变化。

这些风险部分真实，但更适合未来多租户、第三方插件市场和不可信资产分发场景。

### 4.2 当前生产中更直接的风险

- 其他 RPA 与 BPA 同时控制一个浏览器。
- 工作流进入错误店铺或错误标签页。
- 登录失效、验证码或弹窗阻断。
- 页面刷新和 SPA 状态变化导致绑定失效。
- 商品只采集部分，但整轮被表达为失败或空输出。
- 浏览器抽屉、滚动和标签页没有形成完整释放闭环。
- 页面结构变化时缺少可回放证据。

当前安全预算对候选资产治理投入较重，而对浏览器运行时所有权、恢复和数据完整性投入不足。

## 5. 应保留并下沉的安全边界

以下能力仍有必要，但不应要求用户理解或配置：

- 精确 Origin、平台、店铺和标签页身份校验。
- 密码、Cookie、Token、手机号等敏感数据排除和脱敏。
- 登录、验证码、会员限制和平台风控不自动绕过。
- 页面内容不能扩大任务目标、Origin、权限或风险上限。
- 浏览器只读能力与写入能力分离。
- 修改库存、发布、发送外部通知等高影响动作单独确认。
- 操作、证据和人工决定可追溯。
- BPA 只回收能够归因于自身命令的标签页。
- 未知页面和未知弹窗保持安全停止。

这些约束应通过默认策略、Node manifest、Adapter 和 Runtime 自动执行。

## 6. 应从用户路径删除或降级的内容

### 6.1 从业务界面删除

- `Design Mode` 名称和独立导航。
- Authoring Session ID。
- Profile ID。
- Page Binding JSON 复制粘贴。
- Revision、Candidate、CAS、Evidence Digest 等协议概念。
- R0/R1 等平台风险术语。
- 手工输入 Run ID 查询运行或血缘。
- Dataset ID、内部版本等开发字段。

### 6.2 改为后台自动机制

- 自动创建 Authoring/Development Session。
- 自动发现 Browser Instance、Profile 和当前标签页。
- Extension 自动提交 Page Binding。
- 页面刷新后自动重新观察和恢复就绪状态。
- 任务期间自动续租，用户可随时解除绑定。
- 任务范围内按策略采集截图和结构证据，不逐张打断。
- Node、Adapter、Workflow 的风险和权限由系统合并检查。

### 6.3 限定 Candidate Bundle 的适用范围

不可自动应用和发布的 Candidate Bundle 适合：

- 第三方插件。
- 不可信来源的自动化资产。
- 跨团队或外部分发。
- 需要正式发布治理的通用能力。

对本地第一方开发、用户已经明确要求 Codex 修改仓库的场景，不应强制先绕行不可应用的 tar Candidate 流程。正常代码审查、测试、Git diff 和用户授权已经构成更直接的工程闭环。

## 7. 目标 Page Binding 模型

### 7.1 用户交互

```text
用户打开目标页面
→ 点击“绑定当前页面给 BPA”
→ Extension 自动识别平台、店铺和页面类型
→ 工作台显示绑定结果
```

用户只需要看到：

```text
已绑定
抖店 · 昊七七食品旗舰店 · 商品管理
```

### 7.2 建议的内部记录

```ts
interface PageBinding {
  readonly bindingId: string;
  readonly browserInstanceId: string;
  readonly profileId: string;
  readonly tabId: number;
  readonly origin: string;
  readonly platform: string;
  readonly shopId?: string;
  readonly pageKind: string;
  readonly state: "bound" | "ready" | "leased" | "busy" | "recovering" | "offline";
  readonly observedAt: string;
  readonly lastHeartbeatAt: string;
}
```

该结构是内部模型，不是用户表单。

### 7.3 建议的生命周期

```text
discovered
→ bound
→ ready
→ leased
→ busy
→ restoring
→ ready
```

以下事件不应要求重新绑定：

- 同一页面刷新。
- 允许范围内的 SPA 路由变化。
- 抽屉或浮层打开和关闭。
- 页面 DOM 发生普通更新。
- Extension 短暂重新连接。

以下事件应使绑定离线或失效：

- 标签页关闭。
- Origin 离开允许范围。
- 店铺身份变化。
- 登录态失效。
- 浏览器实例消失。
- 用户主动解除绑定。

PageEpoch 可以继续用于标记一次不可变观察，但不应决定长期 Page Binding 的寿命。

## 8. Developer Capture 的正确定位

删除面向用户的 Design Mode 后，保留一个仅供开发使用的 `Developer Capture`：

- 在已绑定页面运行单个 Node。
- 记录操作步骤和状态变化。
- 保存脱敏 DOM 摘要和必要截图。
- 自动生成正常及异常页面夹具。
- 离线回放解析器。
- 比较页面结构版本变化。
- 生成 Adapter Handler 骨架和测试入口。
- 将生产故障证据转化为回归测试。

Developer Capture 应由 Codex、CLI 或开发工具启动，不应要求业务用户填写协议字段。

建议开发路径：

```text
绑定页面
→ 开启开发捕获
→ 执行一条受控交互
→ 自动保存夹具和动作轨迹
→ 离线调试解析器
→ 单节点 smoke
→ 5 个样本商品
→ 单店全量
→ 多店灰度
```

## 9. BPA 应系统级攻克的浏览器能力

本次抖店库存工作流遇到的难点不应继续以业务补丁方式解决，应进入 BPA 浏览器可靠性内核。

### 9.1 跨 RPA 控制权仲裁

- 浏览器资源控制租约。
- 控制者身份和心跳。
- fencing token。
- 冲突时跳过或排队。
- 失联控制者自动回收。
- 人工接管和恢复语义。

### 9.2 操作开始和释放闭环

```text
申请控制权
→ 记录初始页面
→ 执行操作
→ 保存结果或失败证据
→ 关闭自身抽屉和浮层
→ 恢复滚动和分页位置
→ 回收自身创建的标签页
→ 验证页面恢复
→ 释放控制权
```

该闭环应由运行时和标准浏览器节点共同保证，而不是由每个 Adapter 重复实现。

### 9.3 页面状态机和局部恢复

- 页面就绪和稳定性判断。
- 抽屉、浮层、弹窗生命周期。
- 分页和虚拟列表滚动。
- 登录、验证码和风险状态分类。
- 有界局部重试。
- 恢复到基准页面。
- 单项失败隔离和失败率熔断。

### 9.4 录制、证据和回放

- 结构化动作轨迹。
- 失败阶段和错误码。
- 脱敏 DOM 摘要。
- 必要的页面截图。
- 固定版本夹具。
- 纯解析器离线回放。
- 历史故障自动进入回归集。

## 10. Operator Console 的重新定位

### 10.1 业务员工入口

业务面板只展示：

- 需要处理。
- 当前业务风险。
- 正在运行。
- 最近结果。
- 自动计划。
- 数据新鲜度。

页面按具体业务领域设计，例如库存风险、内容生产或经营分析。用户不需要知道底层 Workflow、Node、Adapter 和 Evidence。

### 10.2 开发者入口

现有 Operator Console 可以降级为仅开发者使用的诊断控制台，保留：

- Runtime 和组件状态。
- Browser Binding 和控制租约。
- Workflow / Node 执行时间线。
- Evidence 和诊断包。
- Dataset 和资产版本。
- Developer Capture。

该入口应通过开发者路由、CLI 或明确的开发模式进入，不与员工业务中台混合。

## 11. 问题登记

| 编号 | 问题 | 影响 | 优先级 | 建议处理 |
| --- | --- | --- | --- | --- |
| UX-01 | Design Mode 将内部协议参数暴露给用户 | 授权路径复杂、难以理解 | P0 | 删除用户侧 Design Mode，改为一键 Page Binding |
| UX-02 | Operator Console 混合业务、运行和开发者控制台 | 产品定位和导航心智混乱 | P0 | 业务中台与开发者诊断入口拆分 |
| BIND-01 | Page Binding 与短期 Design Grant、PageEpoch 强耦合 | 页面刷新和动态状态导致反复授权 | P0 | 建立长期绑定，Observation Epoch 独立演进 |
| BIND-02 | 页面绑定、控制权、权限和确认混为一体 | 模型复杂且难以复用 | P0 | 分成四个独立边界 |
| DEV-02 | Design Mode 只能降低简单读取开发成本 | 无法覆盖库存场景核心难点 | P0 | 建立 Developer Capture 和浏览器可靠性内核 |
| SEC-01 | 用户承担了本应由系统自动执行的安全配置 | 打断开发和业务任务 | P1 | 安全策略下沉，只有高影响动作请求确认 |
| SEC-02 | Candidate Bundle 对本地第一方开发约束过强 | 延长从观察到代码验证的路径 | P1 | 仅在第三方或分发场景强制使用 |
| DEV-03 | 缺少从真实页面自动形成夹具和回放的闭环 | 调试依赖反复操作真实浏览器 | P1 | Capture 自动产出诊断包和测试夹具 |
| OPS-01 | 工作台要求手工输入 Run ID、Dataset ID 和版本 | 业务用户被迫理解平台标识 | P1 | 通过任务和结果对象直接导航，开发字段隐藏 |
| CORE-01 | 浏览器控制、恢复和释放仍由业务 Adapter 分散承担 | 每条工作流重复实现且行为不一致 | P0 | 建立标准浏览器运行内核 |

## 12. 建议实施顺序

### P0：纠正产品和资源模型

1. 将 Design Mode 从业务导航移除。
2. 定义稳定的 Page Binding 与生命周期。
3. 将 Binding、Control Lease、Permission、Effect Confirmation 分开。
4. Extension 提供“一键绑定当前页面”。
5. 工作流根据店铺和页面角色自动解析绑定，不要求手工选择 Session。

### P1：降低真实开发成本

1. 建立 Developer Capture。
2. 产出动作轨迹、诊断包和版本化夹具。
3. 支持在绑定页面运行单个 Node 和离线 replay。
4. 将抽屉、浮层、分页、虚拟列表和恢复提炼为平台能力。
5. 建立跨 RPA 控制租约。

### P2：重构用户面板

1. 各业务线使用结果型中台。
2. BPA 通用 Console 仅保留为开发者工具。
3. 所有平台标识和协议术语默认隐藏。
4. 用户只在登录、页面选择、业务判断和高影响动作时介入。

## 13. 验收标准

- 用户绑定页面只需一次点击。
- 用户不输入 Session、Profile、Binding JSON、revision 或 Run ID。
- 同一店铺页面刷新后能够自动恢复，无需重新绑定。
- 工作流能够自动解析符合店铺和页面角色的绑定。
- 其他 RPA 持有控制权时，BPA 不会同时操作。
- 开发者能够从一次真实交互自动获得动作轨迹和脱敏夹具。
- 单节点的大部分解析问题可以离线复现和修复。
- 业务员工入口不显示 Workflow、Node、Adapter、Evidence 或风险等级术语。
- 真正涉及发布、修改库存和外部发送时仍有明确确认与审计。

## 14. 本轮建议决策

- “确认使用当前页面”定义为资源绑定动作，而不是安全审批流程。
- 删除面向用户的 Design Mode，保留内部 Page Binding 和 Developer Capture。
- PageEpoch 只标记观察版本，不决定长期页面绑定寿命。
- 安全能力保留但下沉，不继续向用户暴露内部治理概念。
- BPA 下一阶段的核心投入应是动态页面可靠性，而不是继续扩充 Authoring 协议表单。
- 抖店库存场景的分页、抽屉、浮层、滚动、RPA 干扰、部分成功和释放闭环，作为 BPA 浏览器内核的首个系统级验收场景。
