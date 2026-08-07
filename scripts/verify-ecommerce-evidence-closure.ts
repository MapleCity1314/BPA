import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyEcommerceEvidenceClosure } from "../packages/ecommerce-evidence-domain/src/index.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

const inputPath = resolve(option("--input"));
const runRoot = resolve(option("--run-root"));
const replayInput = JSON.parse(readFileSync(inputPath, "utf8"));
const report = verifyEcommerceEvidenceClosure({
  replayInput,
  runRoot,
  verifiedAt: new Date().toISOString()
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
