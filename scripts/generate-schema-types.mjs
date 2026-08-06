import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { compile } from "json-schema-to-typescript";

const root = resolve(import.meta.dirname, "..");
const schemaDirectory = join(root, "packages", "schemas", "schema");
const outputDirectory = join(root, "packages", "schemas", "src", "generated");
const schemas = [
  "workflow.schema.json",
  "workflow-v1alpha2.schema.json",
  "workflow-v1alpha3.schema.json",
  "node.schema.json",
  "node-v1alpha2.schema.json",
  "source-record.schema.json",
  "asset-record.schema.json",
  "evidence-link.schema.json",
  "adapter-manifest.schema.json",
  "assistance-profile.schema.json",
  "assistance-task.schema.json",
  "deterministic-result-validator-policy.schema.json",
  "dataset.schema.json",
  "decision-record.schema.json",
  "scenario-spec.schema.json",
  "authoring-session.schema.json",
  "page-snapshot.schema.json",
  "candidate-bundle.schema.json",
  "element-contract.schema.json",
  "page-model.schema.json",
  "event.schema.json",
  "permission.schema.json",
  "evidence.schema.json",
  "timing-policy.schema.json",
  "risk-signal.schema.json",
  "trigger-spec.schema.json",
  "browser-protocol-v2.schema.json"
];
const check = process.argv.includes("--check");
const normalizeGeneratedText = (value) => value.replace(/\r\n?/gu, "\n");

await mkdir(outputDirectory, { recursive: true });
const mismatches = [];
for (const filename of schemas) {
  let schema = JSON.parse(
    await readFile(join(schemaDirectory, filename), "utf8")
  );
  if (
    filename === "node.schema.json" ||
    filename === "node-v1alpha2.schema.json" ||
    filename === "workflow.schema.json" ||
    filename === "workflow-v1alpha2.schema.json" ||
    filename === "workflow-v1alpha3.schema.json" ||
    filename === "browser-protocol-v2.schema.json"
  ) {
    const timingPolicySchema = JSON.parse(
      await readFile(
        join(schemaDirectory, "timing-policy.schema.json"),
        "utf8"
      )
    );
    schema = structuredClone(schema);
    schema.$defs = {
      ...(schema.$defs ?? {}),
      timingPolicy: timingPolicySchema
    };
    const serialized = JSON.stringify(schema).replaceAll(
      '"https://bpa.local/schemas/timing-policy/v1"',
      '"#/$defs/timingPolicy"'
    );
    schema = JSON.parse(serialized);
  }
  if (filename === "browser-protocol-v2.schema.json") {
    const permissionSchema = JSON.parse(
      await readFile(
        join(schemaDirectory, "permission.schema.json"),
        "utf8"
      )
    );
    schema.$defs.permissionGrant = permissionSchema;
    const riskSignalSchema = JSON.parse(
      await readFile(
        join(schemaDirectory, "risk-signal.schema.json"),
        "utf8"
      )
    );
    schema.$defs.riskSignal = riskSignalSchema;
    schema = JSON.parse(
      JSON.stringify(schema).replaceAll(
        '"https://bpa.local/schemas/risk-signal/v1"',
        '"#/$defs/riskSignal"'
      )
    );
  }
  const outputName = `${basename(filename, ".schema.json")
    .replaceAll("-", "_")}.d.ts`;
  const generated = normalizeGeneratedText(
    await compile(schema, schema.title, {
      bannerComment:
        "/* Generated from canonical JSON Schema. Do not edit manually. */",
      cwd: schemaDirectory,
      ignoreMinAndMaxItems: true,
      style: {
        singleQuote: false,
        semi: true,
        tabWidth: 2,
        trailingComma: "none"
      }
    })
  );
  const outputPath = join(outputDirectory, outputName);
  if (check) {
    const current = normalizeGeneratedText(
      await readFile(outputPath, "utf8").catch(() => "")
    );
    if (current !== generated) mismatches.push(outputName);
  } else {
    await writeFile(outputPath, generated);
  }
}

const permissionSchema = JSON.parse(
  await readFile(join(schemaDirectory, "permission.schema.json"), "utf8")
);
const browserProtocolSchema = JSON.parse(
  await readFile(
    join(schemaDirectory, "browser-protocol-v2.schema.json"),
    "utf8"
  )
);
const timingPolicySchema = JSON.parse(
  await readFile(join(schemaDirectory, "timing-policy.schema.json"), "utf8")
);
const riskSignalSchema = JSON.parse(
  await readFile(join(schemaDirectory, "risk-signal.schema.json"), "utf8")
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  code: { source: true, esm: true }
});
addFormats(ajv);
ajv.addSchema(permissionSchema);
ajv.addSchema(timingPolicySchema);
ajv.addSchema(riskSignalSchema);
const browserProtocolValidator = ajv.compile(browserProtocolSchema);
const validatorSource = normalizeGeneratedText(
  [
    "/* Generated from canonical JSON Schema. Do not edit manually. */",
    "// @ts-nocheck",
    standaloneCode(ajv, browserProtocolValidator),
    ""
  ].join("\n")
);
const validatorName = "browser_protocol_v2.validator.ts";
const validatorPath = join(outputDirectory, validatorName);
if (check) {
  const current = normalizeGeneratedText(
    await readFile(validatorPath, "utf8").catch(() => "")
  );
  if (current !== validatorSource) mismatches.push(validatorName);
} else {
  await writeFile(validatorPath, validatorSource);
}

if (mismatches.length > 0) {
  process.stderr.write(
    `Generated schema types are stale: ${mismatches.join(", ")}\n`
  );
  process.exitCode = 1;
}
