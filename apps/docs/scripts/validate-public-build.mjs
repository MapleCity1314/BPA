import { readFile, readdir } from "node:fs/promises";
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
  await readFile(join(distDir, "raw", rawPath));
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
  if (!/\.(?:html|json|xml|txt|js|css)$/.test(file)) continue;
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

const pagefindFiles = files.filter((file) => file.includes("/pagefind/"));
if (pagefindFiles.length === 0) {
  throw new Error("Pagefind search index was not generated.");
}

console.log(
  `Validated ${expectedRoutes.length} routes, ${publicSchemas.length + publicExamples.length} protocol artifacts, ${publicDocs.length} machine-readable documents, ${publicStaticAssets.length} static assets, and the public-content boundary.`
);
