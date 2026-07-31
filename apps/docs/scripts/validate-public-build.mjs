import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  expectedRoutes,
  publicExamples,
  publicSchemas,
  publicStaticAssets
} from "./public-specs.mjs";
import { publicDocuments } from "./docs-catalog.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const distDir = join(repoRoot, "apps/docs/dist");
const sourceSchemaDir = join(repoRoot, "packages/schemas/schema");
const sourceExampleDir = join(repoRoot, "docs/protocols/examples");
const publicSpecDir = join(distDir, "specs");
const publicDocs = await publicDocuments();
const repository = process.env.GITHUB_REPOSITORY ?? "MapleCity1314/BPA";
const [repositoryOwner, repositoryName] = repository.split("/");
const isUserSite =
  repositoryName?.toLowerCase() === `${repositoryOwner?.toLowerCase()}.github.io`;
const configuredBase =
  process.env.DOCS_BASE ??
  (process.env.GITHUB_ACTIONS === "true" && repositoryName && !isUserSite
    ? `/${repositoryName}`
    : "/");

const forbiddenText = [
  "fxg.jinritemai.com",
  "doudian.shop",
  "chanmama",
  "douyin",
  "抖店",
  "蝉妈妈",
  "本地 v1 运行与验收",
  "bridge-gateway实验报告",
  "/Users/",
  "Library/Application Support/BPA"
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

for (const route of expectedRoutes) {
  await readFile(join(distDir, route));
}

for (const asset of publicStaticAssets) {
  await readFile(join(distDir, asset));
}

for (const file of [
  "llms.txt",
  "llms-full.txt",
  "docs-index.json",
  "robots.txt"
]) {
  await readFile(join(distDir, file));
}

for (const document of publicDocs) {
  const rawPath = document.route ? `${document.route}.md` : "index.md";
  const raw = await readFile(join(distDir, "raw", rawPath), "utf8");
  if (!raw.includes(`> Digest: ${document.digest}`)) {
    throw new Error(`Raw Markdown digest is missing for ${document.id}`);
  }
}

const docsIndex = JSON.parse(
  await readFile(join(distDir, "docs-index.json"), "utf8")
);
if (
  docsIndex.schemaVersion !== "bpa.docs-index/1" ||
  docsIndex.entries.length !== publicDocs.length
) {
  throw new Error("Machine-readable documentation index is incomplete.");
}
for (const [index, document] of publicDocs.entries()) {
  const indexed = docsIndex.entries[index];
  if (
    indexed.id !== document.id ||
    indexed.digest !== document.digest ||
    !indexed.rawUrl.endsWith(
      `/raw/${document.route ? `${document.route}.md` : "index.md"}`
    )
  ) {
    throw new Error(`Machine-readable index drift for ${document.id}`);
  }
}

const llmsText = await readFile(join(distDir, "llms.txt"), "utf8");
for (const indexed of docsIndex.entries) {
  if (!llmsText.includes(indexed.rawUrl)) {
    throw new Error(`llms.txt is missing ${indexed.id}`);
  }
}

for (const file of publicSchemas) {
  const [source, built] = await Promise.all([
    readFile(join(sourceSchemaDir, file)),
    readFile(join(publicSpecDir, file))
  ]);
  if (!source.equals(built)) {
    throw new Error(`Published schema differs from source: ${file}`);
  }
}

for (const file of publicExamples) {
  const [source, built] = await Promise.all([
    readFile(join(sourceExampleDir, file)),
    readFile(join(publicSpecDir, file))
  ]);
  if (!source.equals(built)) {
    throw new Error(`Published example differs from source: ${file}`);
  }
}

const files = await collectFiles(distDir);
for (const file of files) {
  if (!/\.(?:html|json|xml|txt|md|js|css)$/.test(file)) continue;
  const contents = await readFile(file, "utf8");
  for (const forbidden of forbiddenText) {
    if (contents.includes(forbidden)) {
      throw new Error(
        `Forbidden public content ${JSON.stringify(forbidden)} in ${relative(
          distDir,
          file
        )}`
      );
    }
  }
}

function builtTarget(pathname) {
  let path = decodeURIComponent(pathname);
  const base = configuredBase.replace(/\/+$/, "");
  if (base && base !== "/" && (path === base || path.startsWith(`${base}/`))) {
    path = path.slice(base.length) || "/";
  }
  path = path.replace(/^\/+/, "");
  if (!path) return "index.html";
  if (path.endsWith("/")) return `${path}index.html`;
  return path;
}

for (const route of expectedRoutes) {
  if (!route.endsWith(".html")) continue;
  const html = await readFile(join(distDir, route), "utf8");
  const hrefs = [...html.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]);
  const sourceUrl = new URL(route, "https://docs.local/");
  for (const href of hrefs) {
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("data:")
    ) {
      continue;
    }
    const target = new URL(href, sourceUrl);
    if (target.origin !== sourceUrl.origin) continue;
    const targetPath = builtTarget(target.pathname);
    try {
      await readFile(join(distDir, targetPath));
    } catch {
      throw new Error(`Broken local link in ${route}: ${href} → ${targetPath}`);
    }
  }

  if (
    route !== "404.html" &&
    (!html.includes('type="text/markdown"') ||
      !html.includes("bpa-copy-markdown"))
  ) {
    throw new Error(`Document actions are missing from ${route}`);
  }
}

const themeProbe = await readFile(join(distDir, "index.html"), "utf8");
if (
  !themeProbe.includes("starlight-theme-select") ||
  !themeProbe.includes("starlight-theme")
) {
  throw new Error("Theme selector or persistence script is missing.");
}

const generatedIndexDigest = createHash("sha256")
  .update(await readFile(join(distDir, "docs-index.json")))
  .digest("hex");
if (!/^[a-f0-9]{64}$/.test(generatedIndexDigest)) {
  throw new Error("Failed to digest the documentation index.");
}

const pagefindFiles = files.filter((file) =>
  relative(distDir, file).split(/[\\/]/u).includes("pagefind")
);
if (pagefindFiles.length === 0) {
  throw new Error("Pagefind search index was not generated.");
}

console.log(
  `Validated ${expectedRoutes.length} routes, ${publicSchemas.length + publicExamples.length} protocol artifacts, ${publicDocs.length} machine-readable documents, ${publicStaticAssets.length} static assets, and the public-content boundary.`
);
