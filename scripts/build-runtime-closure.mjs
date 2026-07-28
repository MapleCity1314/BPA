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
import { basename, dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(process.argv[2] ?? "");
const maximumBytes = Number(
  process.env.BPA_RUNTIME_MAX_BYTES ?? 160 * 1024 * 1024
);

if (
  process.argv[2] === undefined ||
  outputRoot === repositoryRoot ||
  outputRoot === dirname(repositoryRoot) ||
  outputRoot === "/"
) {
  throw new Error("Provide a dedicated runtime closure output directory");
}
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.versions.node.split(".")[0] !== "24"
) {
  throw new Error(
    "Runtime closure must be built by the packaged Node.js 24 darwin-arm64 executable"
  );
}

const entryPoints = {
  "bpa-core": join(repositoryRoot, "apps/local-core/src/main.ts"),
  bpa: join(repositoryRoot, "apps/cli/src/main.ts"),
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
  )
};

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
await build({
  entryPoints,
  outdir: join(outputRoot, "bin"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  external: ["better-sqlite3"],
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
  join(repositoryRoot, "nodes/core"),
  join(outputRoot, "assets/nodes")
);
await copyDirectory(
  join(repositoryRoot, "workflows/examples"),
  join(outputRoot, "assets/workflows")
);
await copyFile(
  join(repositoryRoot, "adapters/doudian/doudian.adapter.yaml"),
  join(outputRoot, "assets/adapters/doudian.adapter.yaml")
);
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
  "lib",
  "build/Release/better_sqlite3.node"
]);
const betterSqlitePath = await packageDirectory("better-sqlite3", repositoryRoot);
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
await copyFile(process.execPath, join(outputRoot, "node/bin/node"));
await chmod(join(outputRoot, "node/bin/node"), 0o755);

const rootPackage = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8")
);
const migrationSource = await readFile(
  join(repositoryRoot, "packages/persistence-sqlite/src/migrations.ts"),
  "utf8"
);
const databaseSchemaVersion = Math.max(
  ...[...migrationSource.matchAll(/\bversion:\s*([0-9]+)/g)].map((match) =>
    Number(match[1])
  )
);
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
      dependencies: { "better-sqlite3": betterSqlite.version }
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
      name: `bpa-runtime-${rootPackage.version}`,
      documentNamespace: `https://bpa.local/sbom/${rootPackage.version}`,
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
        }))
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
for (const file of files) {
  if (
    forbiddenNames.includes(basename(file.path)) ||
    /\.(?:pem|p12|key)$/i.test(file.path)
  ) {
    throw new Error(`Forbidden secret-like file in runtime: ${file.relativePath}`);
  }
  const metadata = await stat(file.path);
  const bytes = await readFile(file.path);
  totalBytes += metadata.size;
  manifestFiles.push({
    path: file.relativePath,
    size: metadata.size,
    sha256: digest(bytes)
  });
}
if (totalBytes > maximumBytes) {
  throw new Error(
    `Runtime closure is ${totalBytes} bytes; budget is ${maximumBytes} bytes`
  );
}
manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
await writeFile(
  join(outputRoot, "runtime-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      runtimeVersion: rootPackage.version,
      databaseSchemaVersion,
      platform: "darwin",
      architecture: "arm64",
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
