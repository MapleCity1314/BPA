import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const distDir = join(repoRoot, "apps/docs/dist");
const sourceSchemaDir = join(repoRoot, "packages/schemas/schema");
const sourceExample = join(
  repoRoot,
  "docs/protocols/examples/browser-protocol-v1.messages.json"
);
const publicSpecDir = join(distDir, "specs");

const expectedRoutes = [
  "index.html",
  "browser/v1/index.html",
  "browser/v1/messages/index.html",
  "browser/v1/security/index.html",
  "models/workflow/v1alpha1/index.html",
  "models/node/v1alpha1/index.html",
  "models/execution-event/v1/index.html",
  "models/evidence/v1/index.html",
  "reference/schemas/index.html",
  "reference/examples/index.html",
  "404.html"
];

const publicSchemas = [
  "browser-protocol-v1.schema.json",
  "permission.schema.json",
  "timing-policy.schema.json",
  "risk-signal.schema.json",
  "workflow.schema.json",
  "node.schema.json",
  "event.schema.json",
  "evidence.schema.json"
];

const forbiddenText = [
  "fxg.jinritemai.com",
  "doudian.shop",
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

for (const file of publicSchemas) {
  const [source, built] = await Promise.all([
    readFile(join(sourceSchemaDir, file)),
    readFile(join(publicSpecDir, file))
  ]);
  if (!source.equals(built)) {
    throw new Error(`Published schema differs from source: ${file}`);
  }
}

const [sourceMessages, builtMessages] = await Promise.all([
  readFile(sourceExample),
  readFile(join(publicSpecDir, "browser-protocol-v1.messages.json"))
]);
if (!sourceMessages.equals(builtMessages)) {
  throw new Error("Published protocol messages differ from source.");
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
  `Validated ${expectedRoutes.length} routes, ${publicSchemas.length + 1} artifacts, and the public-content boundary.`
);
