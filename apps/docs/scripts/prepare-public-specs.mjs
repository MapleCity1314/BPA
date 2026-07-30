import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { publicExamples, publicSchemas } from "./public-specs.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = join(repoRoot, "apps/docs/public/specs");
const schemaDir = join(repoRoot, "packages/schemas/schema");
const exampleDir = join(repoRoot, "docs/protocols/examples");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const file of publicSchemas) {
  await copyFile(join(schemaDir, file), join(outputDir, file));
}

for (const file of publicExamples) {
  await copyFile(join(exampleDir, file), join(outputDir, file));
}

console.log(
  `Prepared ${publicSchemas.length + publicExamples.length} allowlisted public artifacts.`
);
