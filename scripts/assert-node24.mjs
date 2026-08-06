import { readFileSync } from "node:fs";

const pinnedVersion = readFileSync(
  new URL("../.nvmrc", import.meta.url),
  "utf8"
).trim();

export function assertNode24(
  version = process.versions.node,
  expected = pinnedVersion
) {
  if (version !== expected) {
    throw new Error(
      [
        `BPA requires Node.js ${expected}; current runtime is ${version}.`,
        "Use the Node.js version pinned by .nvmrc or the Node bundled with the installed BPA Runtime.",
        "Continuing can load native dependencies with an incompatible ABI."
      ].join(" ")
    );
  }
}

assertNode24();
