import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  formatSensitiveFindings,
  sensitiveContentFindings,
  validateReleaseMetadata
} from "./release-gates.mjs";
import {
  assertManagedChromeManifest,
  renderManagedChromeLauncher
} from "./macos-runtime-install-contract.mjs";

const root = resolve(process.argv[2] ?? "");
const staticHostVerification = process.argv.includes("--static-host");
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
const expectedSqliteObservabilityTarget =
  `${release.platform}-${release.architecture}`;
const sqliteObservabilityIdentityValid =
  release.platform === "darwin" && release.architecture === "arm64"
    ? manifest.sqliteObservability?.status === "available" &&
      manifest.sqliteObservability?.entryPoint ===
        "sqlite3_bpasqliteobservability_init" &&
      manifest.sqliteObservability?.path ===
        "node_modules/@bpa/sqlite-observability/dist/bpa_sqlite_observability.dylib"
    : manifest.sqliteObservability?.status === "unsupported_platform" &&
      manifest.sqliteObservability?.target === expectedSqliteObservabilityTarget;
const managedChromeIdentityValid =
  release.platform === "darwin" && release.architecture === "arm64"
    ? (() => {
        try {
          assertManagedChromeManifest(manifest.managedChrome);
          return true;
        } catch {
          return false;
        }
      })()
    : manifest.managedChrome?.status === "unsupported_platform" &&
      manifest.managedChrome?.target === expectedSqliteObservabilityTarget;
if (
  manifest.schemaVersion !== 2 ||
  manifest.browserProtocol !== "bpa.browser/2" ||
  manifest.browserBridge?.buildId !== release.identity ||
  manifest.browserBridge?.extensionVersion !== release.runtimeVersion ||
  manifest.source?.gitCommit !== release.gitCommit ||
  manifest.source?.dirty !== false ||
  manifest.runtimeVersion !== release.runtimeVersion ||
  manifest.gitCommit !== release.gitCommit ||
  manifest.nodeVersion !== release.nodeVersion ||
  !Number.isSafeInteger(manifest.databaseSchemaVersion) ||
  manifest.databaseSchemaVersion < 1 ||
  manifest.platform !== release.platform ||
  manifest.architecture !== release.architecture ||
  !sqliteObservabilityIdentityValid ||
  !managedChromeIdentityValid ||
  (!staticHostVerification && process.versions.node !== release.nodeVersion) ||
  (!staticHostVerification && process.platform !== release.platform) ||
  (!staticHostVerification && process.arch !== release.architecture) ||
  !Array.isArray(manifest.files)
) {
  throw new Error("Runtime manifest identity is invalid");
}

const nodeExecutable =
  release.platform === "win32" ? "node/node.exe" : "node/bin/node";
const wrapperSuffix = release.platform === "win32" ? ".cmd" : "";
const wrapperFiles = [
  `bin/bpa${wrapperSuffix}`,
  `bin/bpa-core${wrapperSuffix}`,
  `bin/bpa-native-host${wrapperSuffix}`,
  `bin/bpa-mcp${wrapperSuffix}`
];
const manifestWrapperFiles =
  release.platform === "darwin" ? wrapperFiles : [];
const externalWrapperFiles =
  release.platform === "win32" ? wrapperFiles : [];
const requiredFiles = [
  nodeExecutable,
  "bin/bpa.js",
  "bin/bpa-console-host.js",
  "bin/bpa-core.js",
  "bin/bpa-core-launcher.js",
  "bin/bpa-core-identity.js",
  "bin/bpa-native-host.js",
  "bin/bpa-mcp.js",
  "bin/bpa-team-worker.js",
  "bin/bpa-runtime-verify.js",
  "bin/bpa-release-scan.js",
  "bin/bpa-sqlite-tool.js",
  "package.json",
  "node_modules/@bpa/sqlite-observability/index.js",
  "node_modules/@bpa/sqlite-observability/package.json",
  "sbom.spdx.json",
  "schema/browser-protocol-v2.schema.json",
  "assets/adapters/doudian-alliance.adapter.yaml",
  "assets/adapters/doudian-inventory.adapter.yaml",
  "assets/adapters/marketplace-search.adapter.yaml",
  "assets/nodes/doudian.alliance.shops.discover.node.yaml",
  "assets/nodes/doudian.alliance.shop.retired-products.scan.node.yaml",
  "assets/nodes/doudian.alliance.retired-products.aggregate.node.yaml",
  "assets/workflows/doudian.alliance-retired-products-monitor.workflow.yaml",
  "extension/manifest.json",
  "console/index.html"
];
if (release.platform === "darwin") {
  requiredFiles.push(
    "bin/bpa-managed-chrome",
    "bin/bpa-managed-chrome-agent.js"
  );
}
requiredFiles.push(...manifestWrapperFiles);
if (manifest.sqliteObservability.status === "available") {
  requiredFiles.push(manifest.sqliteObservability.path);
}
if (release.platform === "win32") {
  requiredFiles.push("bin/bpa-native-host.exe");
}
const expected = new Set([
  "runtime-manifest.json",
  ...externalWrapperFiles,
  ...manifest.files.map((file) => String(file.path))
]);
if (expected.size !== manifest.files.length + 1 + externalWrapperFiles.length) {
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
    !externalWrapperFiles.includes(path)
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
if (release.platform === "darwin") {
  for (const wrapper of wrapperFiles) {
    const source = await readFile(join(root, wrapper), "utf8");
    if (
      !source.includes(`export BPA_RUNTIME_ID="${release.identity}"`) ||
      !source.includes('VERSION_ROOT="${SCRIPT_ROOT:h}"')
    ) {
      throw new Error(`Runtime wrapper identity is invalid: ${wrapper}`);
    }
  }
  const managedChromeLauncher = await readFile(
    join(root, "bin/bpa-managed-chrome"),
    "utf8"
  );
  if (managedChromeLauncher !== renderManagedChromeLauncher(release.identity)) {
    throw new Error("Managed Chrome launcher differs from the Runtime manifest");
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
if (
  extensionManifest.version !== release.runtimeVersion ||
  extensionManifest.version_name !== release.identity
) {
  throw new Error("Extension build identity differs from the Runtime release");
}
const browserProtocolSchema = JSON.parse(
  await readFile(
    join(root, "schema/browser-protocol-v2.schema.json"),
    "utf8"
  )
);
if (
  browserProtocolSchema.$defs?.pageObservation?.properties?.type?.const !==
    "page.observation" ||
  !browserProtocolSchema.$defs?.command?.properties?.payload?.properties
    ?.observation_revision
) {
  throw new Error(
    "Runtime Browser Protocol omits page observations or observation revisions"
  );
}
const backgroundScript = extensionManifest.background?.service_worker;
const contentScripts = extensionManifest.content_scripts?.flatMap(
  (entry) => entry.js ?? []
);
if (
  typeof backgroundScript !== "string" ||
  !Array.isArray(contentScripts) ||
  contentScripts.length === 0
) {
  throw new Error("Extension manifest omits its observation scripts");
}
const backgroundSource = await readFile(
  join(root, "extension", backgroundScript),
  "utf8"
);
const contentSource = (
  await Promise.all(
    contentScripts.map((path) =>
      readFile(join(root, "extension", path), "utf8")
    )
  )
).join("\n");
if (
  !backgroundSource.includes("page.observation") ||
  !backgroundSource.includes("bpa.content.probe") ||
  !contentSource.includes("bpa.content.ready")
) {
  throw new Error(
    "Packaged extension omits the page-observation readiness handshake"
  );
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
