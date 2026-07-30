export function assertNode24(version = process.versions.node) {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (major !== 24) {
    throw new Error(
      [
        `BPA requires Node.js 24.x; current runtime is ${version}.`,
        "Use the Node.js bundled with the installed BPA Runtime or place an exact Node 24 binary first in PATH.",
        "Continuing can load native dependencies with an incompatible ABI."
      ].join(" ")
    );
  }
}

assertNode24();
