import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = join(repoRoot, "apps/docs/public/specs");
const schemaDir = join(repoRoot, "packages/schemas/schema");
const exampleDir = join(repoRoot, "docs/protocols/examples");

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

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const file of publicSchemas) {
  await copyFile(join(schemaDir, file), join(outputDir, file));
}

await copyFile(
  join(exampleDir, "browser-protocol-v1.messages.json"),
  join(outputDir, "browser-protocol-v1.messages.json")
);

console.log(`Prepared ${publicSchemas.length + 1} allowlisted public artifacts.`);
