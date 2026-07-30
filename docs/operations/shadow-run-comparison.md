# Shadow-run 只读迁移比较器

> 文档类别：运维指南。

`@bpa/shadow-run` 用于比较旧重点项检查插件与 BPA 对同一店铺、同一范围执行只读影子任务后的脱敏结果。它不连接浏览器、不读取数据库，也不依赖 Core、Engine 或 Persistence。

```zsh
bpa shadow-compare legacy-result.json bpa-result.json
```

## 输入边界

两侧输入都使用 `bpa.shadow-run/1`，只允许：

- 店铺 ID 与可选展示名；
- 范围 key、状态页签 ID/label 和筛选值；
- expected/observed 商品数量；
- 商品 ID、标题和真实页面问题指纹；
- 任务前预期恢复位置与任务后实际 page/scrollTop；
- 可选包装匹配状态。

未知字段会被拒绝，避免 HTML、证据原文、Cookie 或其他未脱敏内容混入比较产物。字符串会做 NFKC、空白归一化，筛选、商品和问题指纹会去重并稳定排序。筛选值支持真实页面常见的字符串、有限数字、布尔和 null，空关键词也会被保留。

包装匹配状态只做枚举校验，不进入规范化结果、摘要、diff 或迁移判定。`unmatched`、`ambiguous` 等状态因此不会被当成商品问题。`issueFingerprints` 只接受真实页面问题和平台提醒的 `sha256:` 摘要。

## 输出与门禁

`compareShadowRuns({ legacyPlugin, bpa })` 返回稳定的 `bpa.shadow-diff/1`：

- JSON Pointer 风格的 `path`；
- 稳定 `code`、`kind`、`severity`；
- expected/observed 脱敏值；
- blocking/warning 汇总；
- 顶层 `severity`、`canAdvanceMigration`、`decision` 和结果摘要。

以下差异为 `blocking`：店铺 ID、范围、筛选、状态页签 ID、expected/observed 数量、商品集合、标题、问题指纹、恢复页码或滚动位置。任一侧自身数量不闭合、商品数与 observed 不一致、恢复位置未还原，也会阻断。

店铺展示名和状态页签 label 变化为 `warning`，因为店铺 ID 与页签 ID 才是权威身份；只有 warning 时仍可推进迁移。输出不包含时间戳，等价输入无论原始顺序如何都会产生完全相同的 diff 和 digest。

```ts
import { compareShadowRuns } from "@bpa/shadow-run";

const comparison = compareShadowRuns({
  legacyPlugin: legacyResult,
  bpa: bpaResult
});

if (!comparison.canAdvanceMigration) {
  // 保留影子运行，按 blocking code 修复或复核。
}
```
