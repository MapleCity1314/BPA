import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

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
if (
  manifest.schemaVersion !== 1 ||
  !Number.isSafeInteger(manifest.databaseSchemaVersion) ||
  manifest.databaseSchemaVersion < 1 ||
  manifest.platform !== "darwin" ||
  manifest.architecture !== "arm64" ||
  !Array.isArray(manifest.files)
) {
  throw new Error("Runtime manifest identity is invalid");
}

const expected = new Set([
  "runtime-manifest.json",
  "node/bin/node",
  "bin/bpa",
  "bin/bpa-core",
  "bin/bpa-native-host",
  "bin/bpa-mcp",
  ...manifest.files.map((file) => String(file.path))
]);
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
for (const file of manifest.files) {
  const path = join(root, String(file.path));
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime manifest entry is not a regular file: ${file.path}`);
  }
  const bytes = await readFile(path);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (metadata.size !== file.size || sha256 !== file.sha256) {
    throw new Error(`Runtime manifest digest mismatch: ${file.path}`);
  }
  totalBytes += metadata.size;
}
if (totalBytes !== manifest.totalBytes) {
  throw new Error("Runtime manifest total byte count does not match");
}
process.stdout.write(
  `Verified BPA ${manifest.runtimeVersion} runtime closure (${manifest.files.length} files)\n`
);
