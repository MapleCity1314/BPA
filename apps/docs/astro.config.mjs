import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

const repository = process.env.GITHUB_REPOSITORY ?? "MapleCity1314/BPA";
const [owner, repositoryName] = repository.split("/");
const isUserSite = repositoryName?.toLowerCase() === `${owner?.toLowerCase()}.github.io`;
const site =
  process.env.DOCS_SITE ??
  (owner ? `https://${owner.toLowerCase()}.github.io` : "http://localhost:4321");
const base =
  process.env.DOCS_BASE ??
  (process.env.GITHUB_ACTIONS === "true" && repositoryName && !isUserSite
    ? `/${repositoryName}`
    : "/");
const ogImage = new URL(`${base.replace(/\/$/, "")}/og-v2.png`, site).toString();

export default defineConfig({
  site,
  base,
  integrations: [
    sitemap(),
    starlight({
      title: "BPA / Docs",
      description:
        "BPA 架构、执行模型、可信证据、浏览器协议、业务工作台与公共 Schema。",
      favicon: "/favicon.png",
      credits: false,
      lastUpdated: true,
      pagefind: true,
      disable404Route: true,
      locales: {
        root: {
          label: "简体中文",
          lang: "zh-CN"
        }
      },
      customCss: [
        "@fontsource-variable/geist",
        "@fontsource-variable/geist-mono",
        "./src/styles/custom.css"
      ],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        ThemeSelect: "./src/components/Empty.astro",
        LanguageSelect: "./src/components/Empty.astro"
      },
      head: [
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#ffffff",
            media: "(prefers-color-scheme: light)"
          }
        },
        {
          tag: "meta",
          attrs: {
            name: "theme-color",
            content: "#000000",
            media: "(prefers-color-scheme: dark)"
          }
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: ogImage
          }
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:width",
            content: "1200"
          }
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:height",
            content: "630"
          }
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content:
              "BPA Docs：可信浏览器工作流的架构、运行时、证据与协议"
          }
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:card",
            content: "summary_large_image"
          }
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: ogImage
          }
        }
      ],
      sidebar: [
        {
          label: "开始",
          items: [
            { label: "BPA 概览", slug: "" },
            { label: "当前能力", slug: "start/current-status" },
            { label: "核心概念", slug: "start/concepts" },
            { label: "版本与兼容", slug: "reference/versioning" }
          ]
        },
        {
          label: "平台架构",
          items: [
            { label: "模块与边界", slug: "platform/architecture" },
            { label: "执行、恢复与幂等", slug: "platform/runtime-recovery" },
            { label: "业务工作台", slug: "platform/operator-console" }
          ]
        },
        {
          label: "控制与浏览器协议",
          items: [
            { label: "Control Hello", slug: "control/hello" },
            { label: "资源绑定", slug: "control/resource-binding" },
            { label: "证据与资产", slug: "control/trusted-evidence" }
          ]
        },
        {
          label: "Browser Protocol v1",
          items: [
            { label: "边界与生命周期", slug: "browser/v1" },
            { label: "消息参考", slug: "browser/v1/messages" },
            { label: "安全边界", slug: "browser/v1/security" },
            {
              label: "Timing 与 Risk",
              slug: "browser/v1/timing-and-risk"
            }
          ]
        },
        {
          label: "公共模型",
          items: [
            {
              label: "Workflow v1alpha1",
              slug: "models/workflow/v1alpha1"
            },
            {
              label: "Workflow v1alpha2 / v1alpha3",
              slug: "models/workflow/structured"
            },
            { label: "Node v1alpha1", slug: "models/node/v1alpha1" },
            { label: "Node v1alpha2", slug: "models/node/v1alpha2" },
            {
              label: "Assistance Task",
              slug: "models/assistance/v1alpha1"
            },
            {
              label: "Dataset 与 Decision",
              slug: "models/data/v1alpha1"
            },
            {
              label: "Page Model 与 Readiness",
              slug: "models/page/v1alpha1"
            },
            {
              label: "Execution Event v1",
              slug: "models/execution-event/v1"
            },
            { label: "Evidence v1", slug: "models/evidence/v1" }
          ]
        },
        {
          label: "安全与运维",
          items: [
            { label: "数据与保留", slug: "operations/data-security" },
            { label: "安装与升级边界", slug: "operations/runtime" }
          ]
        },
        {
          label: "参考",
          items: [
            { label: "JSON Schema", slug: "reference/schemas" },
            { label: "规范消息样例", slug: "reference/examples" }
          ]
        }
      ]
    })
  ]
});
