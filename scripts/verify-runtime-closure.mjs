import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  formatSensitiveFindings,
  sensitiveContentFindings,
  validateReleaseMetadata
} from "./release-gates.mjs";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/") {
  throw new Error("Provide the exact runtime closure directory");
}

async function collect(directory, base = directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collect(path, base)));
    } else if (entry.isFile()) {
      paths.push(relative(base, path).split("\\").join("/"));
    } else {
      throw new Error(`Runtime contains a non-file entry: ${path}`);
    }
  }
  return paths;
}

const manifest = JSON.parse(
  await readFile(join(root, "runtime-manifest.json"), "utf8")
);
const release = validateReleaseMetadata(manifest.release);
if (
  manifest.schemaVersion !== 2 ||
  manifest.runtimeVersion !== release.runtimeVersion ||
  manifest.gitCommit !== release.gitCommit ||
  manifest.nodeVersion !== release.nodeVersion ||
  !Number.isSafeInteger(manifest.databaseSchemaVersion) ||
  manifest.databaseSchemaVersion < 1 ||
  manifest.platform !== release.platform ||
  manifest.architecture !== release.architecture ||
  process.versions.node !== release.nodeVersion ||
  process.platform !== release.platform ||
  process.arch !== release.architecture ||
  !Array.isArray(manifest.files)
) {
  throw new Error("Runtime manifest identity is invalid");
}

const requiredFiles = [
  "node/bin/node",
  "bin/bpa.js",
  "bin/bpa-core.js",
  "bin/bpa-native-host.js",
  "bin/bpa-mcp.js",
  "bin/bpa-team-worker.js",
  "bin/bpa-runtime-verify.js",
  "bin/bpa-release-scan.js",
  "package.json",
  "sbom.spdx.json",
  "extension/manifest.json",
  "console/index.html"
];
const expected = new Set([
  "runtime-manifest.json",
  "bin/bpa",
  "bin/bpa-core",
  "bin/bpa-native-host",
  "bin/bpa-mcp",
  ...manifest.files.map((file) => String(file.path))
]);
if (expected.size !== manifest.files.length + 5) {
  throw new Error("Runtime manifest contains duplicate file paths");
}
const actual = await collect(root);
for (const path of actual) {
  if (!expected.has(path)) {
    throw new Error(`Unexpected file in runtime closure: ${path}`);
  }
}
for (const path of expected) {
  if (
    !actual.includes(path) &&
    !["bin/bpa", "bin/bpa-core", "bin/bpa-native-host", "bin/bpa-mcp"].includes(
      path
    )
  ) {
    throw new Error(`Runtime closure file is missing: ${path}`);
  }
}

let totalBytes = 0;
const sensitiveFindings = [];
let previousPath = "";
for (const file of manifest.files) {
  if (
    typeof file.path !== "string" ||
    file.path.length === 0 ||
    file.path.startsWith("/") ||
    file.path.split("/").includes("..") ||
    file.path <= previousPath ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(file.sha256))
  ) {
    throw new Error(`Runtime manifest file entry is invalid: ${String(file.path)}`);
  }
  previousPath = file.path;
  const path = join(root, file.path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime manifest entry is not a regular file: ${file.path}`);
  }
  const bytes = await readFile(path);
  sensitiveFindings.push(
    ...sensitiveContentFindings(bytes, file.path)
  );
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (metadata.size !== file.size || sha256 !== file.sha256) {
    throw new Error(`Runtime manifest digest mismatch: ${file.path}`);
  }
  totalBytes += metadata.size;
}
if (totalBytes !== manifest.totalBytes) {
  throw new Error("Runtime manifest total byte count does not match");
}
for (const required of requiredFiles) {
  if (!manifest.files.some((file) => file.path === required)) {
    throw new Error(`Runtime manifest omits required file: ${required}`);
  }
}
if (sensitiveFindings.length > 0) {
  throw new Error(
    `Sensitive content detected in runtime: ${formatSensitiveFindings(
      sensitiveFindings
    )}`
  );
}
const runtimePackage = JSON.parse(
  await readFile(join(root, "package.json"), "utf8")
);
if (
  runtimePackage.version !== release.runtimeVersion ||
  JSON.stringify(runtimePackage.bpaRelease) !== JSON.stringify(release)
) {
  throw new Error("Runtime package identity differs from its manifest");
}
const extensionManifest = JSON.parse(
  await readFile(join(root, "extension/manifest.json"), "utf8")
);
if (extensionManifest.version !== release.runtimeVersion) {
  throw new Error("Extension version differs from the Runtime release");
}
const sbom = JSON.parse(await readFile(join(root, "sbom.spdx.json"), "utf8"));
if (
  sbom.name !== `bpa-runtime-${release.identity}` ||
  sbom.documentNamespace !== `https://bpa.local/sbom/${release.identity}` ||
  !Array.isArray(sbom.packages) ||
  !sbom.packages.some(
    (entry) =>
      entry.name === "bpa" && entry.versionInfo === release.runtimeVersion
  )
) {
  throw new Error("SBOM identity differs from the Runtime release");
}
process.stdout.write(
  `Verified BPA ${release.identity} runtime closure from ${release.gitCommit} (${manifest.files.length} files)\n`
);
