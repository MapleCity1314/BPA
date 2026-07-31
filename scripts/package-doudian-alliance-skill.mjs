import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

const runtimeInput = option("--runtime");
const outputInput = option("--output");
if (!runtimeInput || !outputInput || !outputInput.endsWith(".zip")) {
  throw new Error(
    "Usage: package-doudian-alliance-skill.mjs --runtime <windows-runtime.zip> --output <skill.zip>"
  );
}
const runtimePath = resolve(runtimeInput);
const outputPath = resolve(outputInput);
try {
  await stat(outputPath);
  throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (!/^bpa-local-.+-windows-x64\.zip$/u.test(basename(runtimePath))) {
  throw new Error("Runtime filename does not contain an immutable release identity");
}
const checksumPath = `${runtimePath}.sha256`;
const digest = async (path) =>
  createHash("sha256").update(await readFile(path)).digest("hex");
const expectedRuntimeDigest = (await readFile(checksumPath, "utf8"))
  .trim()
  .split(/\s+/u)[0]
  .toLowerCase();
if ((await digest(runtimePath)) !== expectedRuntimeDigest) {
  throw new Error("Runtime checksum does not match before Skill assembly");
}
await execFileAsync(
  join(repositoryRoot, "scripts/verify-package-windows-x64.sh"),
  [runtimePath],
  {
    env: { ...process.env, BPA_BUNDLED_NODE: process.execPath },
    maxBuffer: 20 * 1024 * 1024
  }
);

const stage = await mkdtemp(join(tmpdir(), "bpa-skill-package-"));
try {
  await cp(
    join(repositoryRoot, "skills/doudian-alliance-retired-monitor"),
    stage,
    { recursive: true }
  );
  const workflowAssets = join(stage, "assets/workflow-assets");
  const runtimeAssets = join(stage, "assets/windows-x64");
  await mkdir(workflowAssets, { recursive: true });
  await mkdir(runtimeAssets, { recursive: true });
  const canonicalAssets = [
    join(
      repositoryRoot,
      "nodes/core/doudian.alliance.shops.discover.node.yaml"
    ),
    join(
      repositoryRoot,
      "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml"
    ),
    join(
      repositoryRoot,
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml"
    ),
    join(repositoryRoot, "adapters/doudian/doudian-alliance.adapter.yaml"),
    join(
      repositoryRoot,
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
    )
  ];
  for (const source of canonicalAssets) {
    await copyFile(source, join(workflowAssets, basename(source)));
  }
  await copyFile(runtimePath, join(runtimeAssets, basename(runtimePath)));
  await copyFile(
    checksumPath,
    join(runtimeAssets, basename(checksumPath))
  );

  async function filesUnder(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) result.push(...(await filesUnder(path)));
      else if (entry.isFile()) result.push(path);
      else throw new Error(`Unsupported Skill package entry: ${path}`);
    }
    return result.sort();
  }

  const files = await filesUnder(stage);
  const manifest = {
    schemaVersion: 1,
    kind: "bpa.workbuddy-skill-delivery",
    skill: "doudian-alliance-retired-monitor",
    runtime: {
      file: basename(runtimePath),
      sha256: expectedRuntimeDigest
    },
    files: await Promise.all(
      files.map(async (path) => ({
        path: relative(stage, path).replaceAll("\\", "/"),
        sha256: await digest(path)
      }))
    )
  };
  await writeFile(
    join(stage, "package-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  const archiveFiles = await filesUnder(stage);
  const fixedTime = new Date("2000-01-01T00:00:00.000Z");
  for (const path of archiveFiles) {
    await chmod(path, 0o644);
    await utimes(path, fixedTime, fixedTime);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await execFileAsync(
    "zip",
    [
      "-X",
      "-q",
      outputPath,
      ...archiveFiles.map((path) => relative(stage, path))
    ],
    { cwd: stage, maxBuffer: 20 * 1024 * 1024 }
  );
  await execFileAsync(
    process.execPath,
    [
      join(repositoryRoot, "scripts/verify-doudian-alliance-skill.mjs"),
      outputPath
    ],
    { maxBuffer: 30 * 1024 * 1024 }
  );
  process.stdout.write(`${outputPath}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
