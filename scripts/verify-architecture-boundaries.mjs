import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const issues = [];
const genericRoots = [
  "packages/gateway-core",
  "packages/resource-binding",
  "packages/persistence",
  "packages/workflow-ir"
];
const genericFiles = [
  "apps/local-core/src/browser-gateway.ts",
  "apps/local-core/src/runtime-resource-bindings.ts",
  "packages/schemas/schema/browser-protocol-v2.schema.json"
];
const businessTokens = [
  /doudian/iu,
  /jinritemai/iu,
  /retired.?products/iu,
  /alliance.?retired/iu,
  /shop_identity/iu,
  /13:00/u
];

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(path)));
    else if ([".ts", ".json"].includes(extname(entry.name))) result.push(path);
  }
  return result;
}

const paths = [
  ...(await Promise.all(genericRoots.map((path) => filesUnder(join(root, path))))).flat(),
  ...genericFiles.map((path) => join(root, path))
];
for (const path of paths) {
  if (path.endsWith(".test.ts")) continue;
  const source = await readFile(path, "utf8");
  for (const token of businessTokens) {
    if (token.test(source)) {
      issues.push(`${relative(root, path)} contains forbidden business token ${token}`);
    }
  }
  if (/from\s+["'][^"']*(?:adapters\/|@bpa\/adapter-|\/src\/)[^"']*["']/u.test(source)) {
    issues.push(`${relative(root, path)} imports an Adapter or private src path`);
  }
}

const appPackages = [];
for (const entry of await readdir(join(root, "apps"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const manifest = JSON.parse(
      await readFile(join(root, "apps", entry.name, "package.json"), "utf8")
    );
    if (typeof manifest.name === "string") appPackages.push(manifest);
  } catch {
    // Documentation-only app directories do not need a package manifest.
  }
}
const appNames = new Set(appPackages.map((manifest) => manifest.name));
for (const manifest of appPackages) {
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (appNames.has(dependency)) {
      issues.push(`${manifest.name} depends directly on executable App ${dependency}`);
    }
  }
}

if (issues.length > 0) {
  throw new Error(`Architecture boundary verification failed:\n- ${issues.join("\n- ")}`);
}
process.stdout.write(
  `Verified ${paths.length} generic architecture sources without business coupling.\n`
);
