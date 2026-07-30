# BPA 文档阅读入口

这份文件是人类与 AI 阅读 BPA 仓库文档时的稳定入口。不要通过文件名中的版本号、
修改时间或目录排序猜测实现状态；先读取 [`catalog.json`](./catalog.json) 中的
`authority` 与 `implementation`。

## 推荐顺序

1. `packages/schemas/schema/`：正式数据结构的唯一事实来源。
2. `docs/protocols/`：当前协议、状态机和兼容规则。
3. `docs/adr/` 与 `docs/normative/`：架构决策和平台级约束。
4. `docs/current/`：仓库当前已经实现、部分实现和待验收的能力。
5. `docs/operations/`：安装、运行、恢复和发布方式。
6. `docs/plans/`：未来设计，不代表能力已经交付。
7. `docs/research/`：业务研究和抽象依据。
8. `docs/archive/`：仅用于追溯，不能作为当前实现依据。

## 冲突处理

出现描述冲突时，按下面的顺序判断：

```text
Schema / 已确认协议
→ ADR / 正式规范
→ 当前实况
→ 运维文档
→ 计划
→ 研究
→ 历史归档
```

代码与自动测试能证明“实现存在”，但不能单独证明真实业务页面已经验收。文档写明
`partial` 时，不得将 fixture、replay 或协议候选描述成完整业务能力。

## 公开文档

对外集成优先阅读 [BPA Docs](https://maplecity1314.github.io/BPA/)。
机器读取入口为：

- [`llms.txt`](https://maplecity1314.github.io/BPA/llms.txt)
- [`docs-index.json`](https://maplecity1314.github.io/BPA/docs-index.json)
- [`llms-full.txt`](https://maplecity1314.github.io/BPA/llms-full.txt)

公开站只包含 `catalog.json` 中 `public: true` 的文档。内部业务来源、登录页面、本机
路径、实验材料和归档不会因为存在于仓库中而自动进入公开构建。
