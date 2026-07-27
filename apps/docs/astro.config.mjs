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
const ogImage = new URL(`${base.replace(/\/$/, "")}/og.png`, site).toString();

export default defineConfig({
  site,
  base,
  integrations: [
    sitemap(),
    starlight({
      title: "BPA / Protocols",
      description:
        "BPA 对外协议、公共数据模型、JSON Schema 与规范消息样例。",
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
              "BPA Browser Protocol v1：Gateway 与 Extension Bridge 消息序列"
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
            { label: "协议概览", slug: "" },
            { label: "版本与兼容", slug: "reference/versioning" }
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
            { label: "Node v1alpha1", slug: "models/node/v1alpha1" },
            {
              label: "Execution Event v1",
              slug: "models/execution-event/v1"
            },
            { label: "Evidence v1", slug: "models/evidence/v1" }
          ]
        },
        {
          label: "Reference",
          items: [
            { label: "JSON Schema", slug: "reference/schemas" },
            { label: "规范消息样例", slug: "reference/examples" }
          ]
        }
      ]
    })
  ]
});
