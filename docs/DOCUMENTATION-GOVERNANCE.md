# BPA 文档治理规则

`docs/catalog.json` 是文档分类、状态、受众、公开边界和导航顺序的唯一目录。新增、
移动或删除 Markdown 时必须同步更新 Catalog，并运行 `pnpm docs:check`。

## 权威等级

| `authority` | 用途 |
| --- | --- |
| `current-state` | 当前实现和验收状态 |
| `normative` | 正式协议、安全约束和不可违反的规则 |
| `architecture` | 模块边界、执行模型和 ADR |
| `operations` | 安装、运行、恢复、发布 |
| `tutorial` | 面向具体任务的使用说明 |
| `plan` | 尚未完全实现的设计 |
| `research` | 业务研究、实验和复盘 |
| `historical` | 已被替代、仅供追溯 |

## 实现状态

- `active`：内容与当前代码、测试或正式协议一致。
- `partial`：基础能力存在，但仍有真实环境、完整链路或产品入口缺口。
- `planned`：设计已经记录，不能对外描述为已交付。
- `deprecated`：不再推荐使用，但暂未指定唯一替代项。
- `superseded`：已经有明确替代文档。

## 公开边界

只有同时满足以下条件的文档才能设置 `public: true`：

1. 来源位于 `apps/docs/src/content/docs/`。
2. 不包含真实业务域名、账号、凭据、本机绝对路径或未脱敏证据。
3. 状态与当前 Schema、代码和测试一致。
4. 已配置稳定 route、导航分组和顺序。

公开页面、导航、Raw Markdown、`llms.txt`、`llms-full.txt` 与
`docs-index.json` 都由 Catalog 派生。不得为其中任一输出维护第二份手工页面清单。

## 修改规则

- 当前文档不能把 `historical` 或 `superseded` 文档作为权威依据。
- `supersedes` 必须指向 Catalog 中存在的文档 ID。
- 同一源文件和同一公开 route 都必须唯一。
- 历史文档不删除事实，但必须在文件开头明确标记归档状态。
- `AGENTS.md`、`CLAUDE.md` 和本机私有说明不属于公开文档源。
