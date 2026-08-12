import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import {
  createReleaseMetadata,
  formatSensitiveFindings,
  sensitiveContentFindings
} from "./release-gates.mjs";
import {
  MACOS_MANAGED_CHROME_CONTRACT,
  renderManagedChromeLauncher
} from "./macos-runtime-install-contract.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const pinnedNodeVersion = (
  await readFile(join(repositoryRoot, ".nvmrc"), "utf8")
).trim();
const outputRoot = resolve(process.argv[2] ?? "");
const targetPlatform = process.env.BPA_TARGET_PLATFORM ?? process.platform;
const targetArchitecture =
  process.env.BPA_TARGET_ARCHITECTURE ?? process.arch;
const targetNodeVersion =
  process.env.BPA_TARGET_NODE_VERSION ?? process.versions.node;
const targetNodeExecutable = resolve(
  process.env.BPA_TARGET_NODE_EXECUTABLE ?? process.execPath
);
const targetSqliteBinary = process.env.BPA_TARGET_SQLITE_BINARY
  ? resolve(process.env.BPA_TARGET_SQLITE_BINARY)
  : undefined;
const targetNativeHostExecutable =
  process.env.BPA_TARGET_NATIVE_HOST_EXECUTABLE
    ? resolve(process.env.BPA_TARGET_NATIVE_HOST_EXECUTABLE)
    : undefined;
const chromeForTestingApp = process.env.BPA_CHROME_FOR_TESTING_APP
  ? resolve(process.env.BPA_CHROME_FOR_TESTING_APP)
  : undefined;
const maximumBytes = Number(
  process.env.BPA_RUNTIME_MAX_BYTES ??
    (targetPlatform === "win32" ? 256 : 1_536) * 1024 * 1024
);

if (
  process.argv[2] === undefined ||
  outputRoot === repositoryRoot ||
  outputRoot === dirname(repositoryRoot) ||
  outputRoot === "/"
) {
  throw new Error("Provide a dedicated runtime closure output directory");
}
if (process.versions.node !== pinnedNodeVersion) {
  throw new Error(
    `Runtime closure must be built by pinned Node.js ${pinnedNodeVersion}`
  );
}
const supportedTarget =
  (targetPlatform === "darwin" && targetArchitecture === "arm64") ||
  (targetPlatform === "win32" && targetArchitecture === "x64");
if (!supportedTarget) {
  throw new Error(
    `Runtime closure target is unsupported: ${targetPlatform}-${targetArchitecture}`
  );
}
if (
  targetPlatform === "darwin" &&
  targetArchitecture === "arm64" &&
  chromeForTestingApp === undefined
) {
  throw new Error("BPA_CHROME_FOR_TESTING_APP is required for macOS Runtime closure");
}
if (!/^24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(targetNodeVersion)) {
  throw new Error(`Target Node.js version is invalid: ${targetNodeVersion}`);
}
if (targetNodeVersion !== pinnedNodeVersion) {
  throw new Error(
    `Target Node.js ${targetNodeVersion} does not match pinned ${pinnedNodeVersion}`
  );
}
if (
  (targetPlatform !== process.platform ||
    targetArchitecture !== process.arch) &&
  !targetSqliteBinary
) {
  throw new Error(
    "Cross-platform closure requires BPA_TARGET_SQLITE_BINARY"
  );
}
if (targetPlatform === "win32" && !targetNativeHostExecutable) {
  throw new Error(
    "Windows closure requires BPA_TARGET_NATIVE_HOST_EXECUTABLE"
  );
}
const trackedChanges = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: repositoryRoot, encoding: "utf8" }
).trim();
if (trackedChanges.length > 0) {
  throw new Error(
    "Release closure must be built from a clean tracked Git checkout"
  );
}
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8"
}).trim();

const entryPoints = {
  "bpa-core": join(repositoryRoot, "apps/local-core/src/main.ts"),
  "bpa-core-launcher": join(
    repositoryRoot,
    "scripts/windows-core-launcher.mjs"
  ),
  "bpa-core-identity": join(
    repositoryRoot,
    "scripts/verify-core-process-identity.mjs"
  ),
  bpa: join(repositoryRoot, "apps/cli/src/main.ts"),
  "bpa-console-host": join(
    repositoryRoot,
    "apps/console-host/src/main.ts"
  ),
  "bpa-native-host": join(
    repositoryRoot,
    "apps/native-host/src/main.ts"
  ),
  "bpa-mcp": join(repositoryRoot, "apps/mcp-server/src/main.ts"),
  "bpa-team-worker": join(
    repositoryRoot,
    "apps/team-worker/src/main.ts"
  ),
  "bpa-runtime-verify": join(
    repositoryRoot,
    "scripts/verify-runtime-closure.mjs"
  ),
  "bpa-release-scan": join(
    repositoryRoot,
    "scripts/scan-release-contents.mjs"
  ),
  "bpa-sqlite-tool": join(
    repositoryRoot,
    "scripts/windows-sqlite-tool.mjs"
  )
};
if (targetPlatform === "darwin") {
  entryPoints["bpa-managed-chrome-agent"] = join(
    repositoryRoot,
    "scripts/macos-runtime-install-gates.mjs"
  );
}

async function copyDirectory(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true
  });
}

async function copyFile(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { preserveTimestamps: true });
}

async function packageDirectory(name, from) {
  const packageJsonPath = createRequire(import.meta.url).resolve(
    `${name}/package.json`,
    { paths: [from] }
  );
  return dirname(await realpath(packageJsonPath));
}

async function copyRuntimeDependency(name, files, from = repositoryRoot) {
  const source = await packageDirectory(name, from);
  for (const file of files) {
    const sourcePath = join(source, file);
    const metadata = await stat(sourcePath);
    if (metadata.isDirectory()) {
      await copyDirectory(
        sourcePath,
        join(outputRoot, "node_modules", name, file)
      );
    } else {
      await copyFile(
        sourcePath,
        join(outputRoot, "node_modules", name, file)
      );
    }
  }
  const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  return {
    name,
    version: String(metadata.version),
    license: String(metadata.license ?? "UNKNOWN")
  };
}

async function copyAdapterManifests() {
  const targetNames = new Set();
  for (const directory of await readdir(join(repositoryRoot, "adapters"), {
    withFileTypes: true
  })) {
    if (!directory.isDirectory()) continue;
    const sourceRoot = join(repositoryRoot, "adapters", directory.name);
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".adapter.yaml")) continue;
      if (targetNames.has(entry.name)) {
        throw new Error(`Duplicate packaged Adapter filename: ${entry.name}`);
      }
      targetNames.add(entry.name);
      await copyFile(
        join(sourceRoot, entry.name),
        join(outputRoot, "assets/adapters", entry.name)
      );
    }
  }
  if (targetNames.size === 0) throw new Error("No Adapter manifests found");
}

async function collectFiles(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, base)));
    } else if (entry.isFile()) {
      files.push({
        path,
        relativePath: relative(base, path).split("\\").join("/")
      });
    } else {
      throw new Error(`Runtime closure contains a non-file entry: ${path}`);
    }
  }
  return files;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "bin"), { recursive: true });
if (chromeForTestingApp !== undefined) {
  await cp(
    chromeForTestingApp,
    join(outputRoot, MACOS_MANAGED_CHROME_CONTRACT.applicationRelativePath),
    { recursive: true, dereference: true }
  );
}
await build({
  entryPoints,
  outdir: join(outputRoot, "bin"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  external: ["better-sqlite3", "@bpa/sqlite-observability"],
  banner: {
    js: 'import { createRequire as __bpaCreateRequire } from "node:module"; const require = __bpaCreateRequire(import.meta.url);'
  },
  legalComments: "none",
  minify: false,
  sourcemap: false
});

await copyDirectory(
  join(repositoryRoot, "packages/schemas/schema"),
  join(outputRoot, "schema")
);
await copyDirectory(
  join(repositoryRoot, "apps/extension/.output/chrome-mv3"),
  join(outputRoot, "extension")
);
await copyDirectory(
  join(repositoryRoot, "apps/operator-console/dist"),
  join(outputRoot, "console")
);
await copyDirectory(
  join(repositoryRoot, "nodes/core"),
  join(outputRoot, "assets/nodes")
);
await copyDirectory(
  join(repositoryRoot, "workflows/examples"),
  join(outputRoot, "assets/workflows")
);
await copyAdapterManifests();
await copyDirectory(
  join(repositoryRoot, "assistance-profiles/core"),
  join(outputRoot, "assets/assistance-profiles")
);
await copyDirectory(
  join(repositoryRoot, "policies/core"),
  join(outputRoot, "assets/policies")
);

const betterSqlite = await copyRuntimeDependency("better-sqlite3", [
  "package.json",
  "LICENSE",
  "lib"
]);
const betterSqlitePath = await packageDirectory("better-sqlite3", repositoryRoot);
await copyFile(
  targetSqliteBinary ??
    join(betterSqlitePath, "build/Release/better_sqlite3.node"),
  join(
    outputRoot,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  )
);
const bindings = await copyRuntimeDependency(
  "bindings",
  ["package.json", "LICENSE.md", "bindings.js"],
  betterSqlitePath
);
const bindingsPath = await packageDirectory("bindings", betterSqlitePath);
const fileUriToPath = await copyRuntimeDependency(
  "file-uri-to-path",
  ["package.json", "LICENSE", "index.js"],
  bindingsPath
);
const sqliteObservabilityRoot = join(
  repositoryRoot,
  "packages/sqlite-observability"
);
const sqliteObservabilityPackage = JSON.parse(
  await readFile(join(sqliteObservabilityRoot, "package.json"), "utf8")
);
const packagedSqliteObservabilityRoot = join(
  outputRoot,
  "node_modules/@bpa/sqlite-observability"
);
await copyFile(
  join(sqliteObservabilityRoot, "index.js"),
  join(packagedSqliteObservabilityRoot, "index.js")
);
await writeFile(
  join(packagedSqliteObservabilityRoot, "package.json"),
  `${JSON.stringify(
    {
      name: sqliteObservabilityPackage.name,
      version: sqliteObservabilityPackage.version,
      private: true,
      license: sqliteObservabilityPackage.license,
      type: "module",
      main: "index.js",
      exports: { ".": "./index.js" }
    },
    null,
    2
  )}\n`
);
const sqliteObservability =
  targetPlatform === "darwin" && targetArchitecture === "arm64"
    ? {
        status: "available",
        entryPoint: "sqlite3_bpasqliteobservability_init",
        path: "node_modules/@bpa/sqlite-observability/dist/bpa_sqlite_observability.dylib"
      }
    : {
        status: "unsupported_platform",
        target: `${targetPlatform}-${targetArchitecture}`
      };
if (sqliteObservability.status === "available") {
  await copyFile(
    join(
      sqliteObservabilityRoot,
      "dist/bpa_sqlite_observability.dylib"
    ),
    join(outputRoot, sqliteObservability.path)
  );
}
const packagedNodeRelative =
  targetPlatform === "win32" ? "node/node.exe" : "node/bin/node";
await copyFile(
  targetNodeExecutable,
  join(outputRoot, packagedNodeRelative)
);
if (targetPlatform !== "win32") {
  await chmod(join(outputRoot, packagedNodeRelative), 0o755);
} else {
  await copyFile(
    targetNativeHostExecutable,
    join(outputRoot, "bin/bpa-native-host.exe")
  );
}

const rootPackage = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8")
);
const release = createReleaseMetadata({
  runtimeVersion: String(rootPackage.version),
  gitCommit,
  nodeVersion: targetNodeVersion,
  platform: targetPlatform,
  architecture: targetArchitecture
});
const extensionManifest = JSON.parse(
  await readFile(join(outputRoot, "extension/manifest.json"), "utf8")
);
if (
  extensionManifest.version !== release.runtimeVersion ||
  extensionManifest.version_name !== release.identity
) {
  throw new Error(
    `Browser Bridge identity mismatch: expected ${release.identity}, got ${String(
      extensionManifest.version_name ?? extensionManifest.version
    )}`
  );
}
if (targetPlatform === "darwin") {
  const wrapperTargets = {
    bpa: "bpa.js",
    "bpa-core": "bpa-core.js",
    "bpa-native-host": "bpa-native-host.js",
    "bpa-mcp": "bpa-mcp.js"
  };
  for (const [name, target] of Object.entries(wrapperTargets)) {
    const wrapperPath = join(outputRoot, "bin", name);
    const coreEnvironment = name === "bpa-core"
      ? `if [[ -z "\${BPA_HOME:-}" ]]; then
  print -u2 "BPA_HOME is required to start BPA Core."
  exit 1
fi
CORE_ENV="\$BPA_HOME/core.env"
if [[ -f "\$CORE_ENV" ]]; then
  if [[ "$(stat -f '%Su:%Lp' "\$CORE_ENV")" != "$(id -un):600" ]]; then
    print -u2 "BPA Core configuration owner or permissions are invalid."
    exit 1
  fi
  set -a
  source "\$CORE_ENV"
  set +a
fi
`
      : "";
    await writeFile(
      wrapperPath,
      `#!/bin/zsh
set -euo pipefail
SCRIPT_ROOT="\${0:A:h}"
VERSION_ROOT="\${SCRIPT_ROOT:h}"
${coreEnvironment}export BPA_RUNTIME_ID="${release.identity}"
exec "\$VERSION_ROOT/node/bin/node" "\$VERSION_ROOT/bin/${target}" "\$@"
`
    );
    await chmod(wrapperPath, 0o755);
  }
  const managedChromeLauncher = join(outputRoot, "bin/bpa-managed-chrome");
  await writeFile(
    managedChromeLauncher,
    renderManagedChromeLauncher(release.identity)
  );
  await chmod(managedChromeLauncher, 0o755);
}
const migrationSource = await readFile(
  join(repositoryRoot, "packages/persistence-sqlite/src/migrations.ts"),
  "utf8"
);
const databaseSchemaVersion = Math.max(
  ...[...migrationSource.matchAll(/\bversion:\s*([0-9]+)/g)].map((match) =>
    Number(match[1])
  )
);
const managedChrome =
  targetPlatform === "darwin" && targetArchitecture === "arm64"
    ? MACOS_MANAGED_CHROME_CONTRACT
    : {
        status: "unsupported_platform",
        target: `${targetPlatform}-${targetArchitecture}`
      };
if (!Number.isSafeInteger(databaseSchemaVersion) || databaseSchemaVersion < 1) {
  throw new Error("Could not derive the packaged SQLite Schema version");
}
await writeFile(
  join(outputRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "bpa-runtime-closure",
      version: rootPackage.version,
      private: true,
      type: "module",
      engines: { node: ">=24 <25" },
      dependencies: {
        "better-sqlite3": betterSqlite.version,
        "@bpa/sqlite-observability": sqliteObservabilityPackage.version
      },
      bpaRelease: release
    },
    null,
    2
  )}\n`
);
await writeFile(
  join(outputRoot, "sbom.spdx.json"),
  `${JSON.stringify(
    {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: `bpa-runtime-${release.identity}`,
      documentNamespace: `https://bpa.local/sbom/${release.identity}`,
      packages: [
        {
          SPDXID: "SPDXRef-Package-BPA",
          name: "bpa",
          versionInfo: rootPackage.version,
          licenseConcluded: "NOASSERTION"
        },
        ...[betterSqlite, bindings, fileUriToPath].map((dependency) => ({
          SPDXID: `SPDXRef-Package-${dependency.name.replaceAll(
            /[^A-Za-z0-9.-]/g,
            "-"
          )}`,
          name: dependency.name,
          versionInfo: dependency.version,
          licenseConcluded: dependency.license
        })),
        {
          SPDXID: "SPDXRef-Package-bpa-sqlite-observability",
          name: sqliteObservabilityPackage.name,
          versionInfo: sqliteObservabilityPackage.version,
          licenseConcluded: "NOASSERTION"
        }
      ]
    },
    null,
    2
  )}\n`
);

const forbiddenNames = [
  ".env",
  "CLAUDE.md",
  "SKILL.md",
  "id_rsa",
  "id_ed25519"
];
const files = await collectFiles(outputRoot);
let totalBytes = 0;
const manifestFiles = [];
const sensitiveFindings = [];
for (const file of files.sort((left, right) =>
  left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : 0
)) {
  if (
    forbiddenNames.includes(basename(file.path)) ||
    /\.(?:pem|p12|key)$/i.test(file.path)
  ) {
    throw new Error(`Forbidden secret-like file in runtime: ${file.relativePath}`);
  }
  const metadata = await stat(file.path);
  const bytes = await readFile(file.path);
  sensitiveFindings.push(
    ...sensitiveContentFindings(bytes, file.relativePath)
  );
  totalBytes += metadata.size;
  manifestFiles.push({
    path: file.relativePath,
    size: metadata.size,
    sha256: digest(bytes)
  });
}
if (sensitiveFindings.length > 0) {
  throw new Error(
    `Sensitive content detected in runtime closure: ${formatSensitiveFindings(
      sensitiveFindings
    )}`
  );
}
if (totalBytes > maximumBytes) {
  throw new Error(
    `Runtime closure is ${totalBytes} bytes; budget is ${maximumBytes} bytes`
  );
}
await writeFile(
  join(outputRoot, "runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 2,
      runtimeVersion: rootPackage.version,
      browserProtocol: "bpa.browser/2",
      browserBridge: {
        buildId: release.identity,
        extensionVersion: release.runtimeVersion
      },
      databaseSchemaVersion,
      sqliteObservability,
      managedChrome,
      source: {
        gitCommit: release.gitCommit,
        dirty: false
      },
      release,
      gitCommit: release.gitCommit,
      nodeVersion: release.nodeVersion,
      platform: release.platform,
      architecture: release.architecture,
      totalBytes,
      files: manifestFiles
    },
    null,
    2
  )}\n`
);

for (const name of Object.keys(entryPoints)) {
  await chmod(join(outputRoot, "bin", `${name}.js`), 0o755);
}

const closure = await lstat(outputRoot);
if (!closure.isDirectory()) {
  throw new Error("Runtime closure was not created as a directory");
}
process.stdout.write(
  `Built BPA ${rootPackage.version} runtime closure: ${manifestFiles.length} files, ${totalBytes} bytes\n`
);
