---
title: 机器可读文档
description: BPA 的 llms.txt、完整文本索引、结构化目录和 Raw Markdown 入口。
---

BPA 为搜索引擎、Codex、Claude 和其他文档消费者提供明确的机器入口，不要求模型
通过文件名或页面视觉猜测权威状态。

## 入口

| 文件 | 用途 |
| --- | --- |
| [`llms.txt`](../../llms.txt) | 精简阅读顺序、关键页面和状态 |
| [`llms-full.txt`](../../llms-full.txt) | 按权威顺序合并的公开正文 |
| [`docs-index.json`](../../docs-index.json) | URL、受众、权威、实现状态和 SHA-256 |
| [`sitemap-index.xml`](../../sitemap-index.xml) | 搜索引擎页面发现 |
| [`robots.txt`](../../robots.txt) | 项目路径下的抓取策略 |

每个公开页面还提供 `/raw/<slug>.md`，并在 HTML `<head>` 中声明
`rel="alternate"` 的 Markdown 地址。

## 权威顺序

```text
current-state
→ normative
→ architecture
→ operations
→ tutorial
→ plan
→ research
→ historical
```

公开 `llms-full.txt` 不包含内部计划、研究、历史归档、真实业务域名、本机路径或登录
材料。`docs-index.json` 的摘要针对原始公开文档正文，构建结果可重复验证。

## 关于 robots.txt

当前站点部署在 GitHub Pages 项目子路径 `/BPA/`。项目内的 `robots.txt` 可以表达
意图并链接 Sitemap，但不是 `maplecity1314.github.io` 域名根级 robots 策略。
因此机器目录以 `llms.txt` 和 `docs-index.json` 为准。
