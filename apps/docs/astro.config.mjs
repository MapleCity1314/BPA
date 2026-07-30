import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(
  readFileSync(new URL("../../docs/catalog.json", import.meta.url), "utf8")
);

const navigationLabels = {
  start: "开始",
  guides: "使用指南",
  platform: "平台原理",
  protocol: "协议",
  models: "公共模型",
  operations: "运维与安全",
  reference: "参考"
};
const itemLabelOverrides = {
  "site.home": "BPA 概览"
};
const sidebar = Object.entries(navigationLabels).flatMap(([group, label]) => {
  const items = catalog.entries
    .filter((entry) => entry.public && entry.navigationGroup === group)
    .sort((left, right) => left.navigationOrder - right.navigationOrder)
    .map((entry) => ({
      label: itemLabelOverrides[entry.id] ?? entry.title,
      slug: entry.route
    }));
  return items.length ? [{ label, items }] : [];
});

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
const ogImage = new URL(`${base.replace(/\/$/, "")}/og-v3.png`, site).toString();

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
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/MapleCity1314/BPA"
        }
      ],
      editLink: {
        baseUrl: "https://github.com/MapleCity1314/BPA/edit/main/apps/docs/"
      },
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
        Header: "./src/components/Header.astro",
        Head: "./src/components/Head.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Footer: "./src/components/Footer.astro",
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
      sidebar
    })
  ]
});
