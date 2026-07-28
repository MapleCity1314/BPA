import { resolve } from "node:path";
import {
  formatSensitiveFindings,
  scanReleaseTree
} from "./release-gates.mjs";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/") {
  throw new Error("Provide the exact extracted release directory");
}
const findings = await scanReleaseTree(root);
if (findings.length > 0) {
  throw new Error(
    `Sensitive content detected in release: ${formatSensitiveFindings(findings)}`
  );
}
process.stdout.write(`Sensitive-content scan passed: ${root}\n`);
