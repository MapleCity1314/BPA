import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { compile } from "json-schema-to-typescript";

const root = resolve(import.meta.dirname, "..");
const schemaDirectory = join(root, "packages", "schemas", "schema");
const outputDirectory = join(root, "packages", "schemas", "src", "generated");
const schemas = [
  "workflow.schema.json",
  "node.schema.json",
  "event.schema.json",
  "permission.schema.json",
  "evidence.schema.json",
  "browser-protocol-v1.schema.json"
];
const check = process.argv.includes("--check");

await mkdir(outputDirectory, { recursive: true });
const mismatches = [];
for (const filename of schemas) {
  let schema = JSON.parse(
    await readFile(join(schemaDirectory, filename), "utf8")
  );
  if (filename === "browser-protocol-v1.schema.json") {
    const permissionSchema = JSON.parse(
      await readFile(
        join(schemaDirectory, "permission.schema.json"),
        "utf8"
      )
    );
    schema = structuredClone(schema);
    schema.$defs.permissionGrant = permissionSchema;
  }
  const outputName = `${basename(filename, ".schema.json")
    .replaceAll("-", "_")}.d.ts`;
  const generated = await compile(schema, schema.title, {
    bannerComment:
      "/* Generated from canonical JSON Schema. Do not edit manually. */",
    cwd: schemaDirectory,
    style: {
      singleQuote: false,
      semi: true,
      tabWidth: 2,
      trailingComma: "none"
    }
  });
  const outputPath = join(outputDirectory, outputName);
  if (check) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== generated) mismatches.push(outputName);
  } else {
    await writeFile(outputPath, generated);
  }
}

if (mismatches.length > 0) {
  process.stderr.write(
    `Generated schema types are stale: ${mismatches.join(", ")}\n`
  );
  process.exitCode = 1;
}
