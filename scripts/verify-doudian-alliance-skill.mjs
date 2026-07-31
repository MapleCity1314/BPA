import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const skillSource = join(
  repositoryRoot,
  "skills/doudian-alliance-retired-monitor"
);
const canonicalAssets = {
  "doudian.alliance.shops.discover.node.yaml": join(
    repositoryRoot,
    "nodes/core/doudian.alliance.shops.discover.node.yaml"
  ),
  "doudian.alliance.shop.retired-products.scan.node.yaml": join(
    repositoryRoot,
    "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml"
  ),
  "doudian.alliance.retired-products.aggregate.node.yaml": join(
    repositoryRoot,
    "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml"
  ),
  "doudian-alliance.adapter.yaml": join(
    repositoryRoot,
    "adapters/doudian/doudian-alliance.adapter.yaml"
  ),
  "doudian.alliance-retired-products-monitor.workflow.yaml": join(
    repositoryRoot,
    "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
  )
};

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function requireFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function verifySource() {
  const required = [
    "SKILL.md",
    "agents/openai.yaml",
    "references/workbuddy-install-prompt.md",
    "references/workbuddy-automation-prompt.md",
    "scripts/Install-DoudianAllianceMonitor.ps1"
  ];
  for (const relativePath of required) {
    await requireFile(join(skillSource, relativePath), relativePath);
  }
  const installer = await readFile(
    join(skillSource, "scripts/Install-DoudianAllianceMonitor.ps1"),
    "utf8"
  );
  for (const [filename, path] of Object.entries(canonicalAssets)) {
    const expectedDigest = await digest(path);
    if (
      !installer.includes(filename) ||
      !installer.includes(expectedDigest)
    ) {
      throw new Error(
        `Installer asset pin is stale for ${filename}: ${expectedDigest}`
      );
    }
  }
  const promptDigest = await digest(
    join(skillSource, "references/workbuddy-automation-prompt.md")
  );
  if (!installer.includes(promptDigest)) {
    throw new Error("Installer automation prompt pin is stale");
  }
  await requireFile(
    join(repositoryRoot, "scripts/package-doudian-alliance-skill.mjs"),
    "deterministic Skill packager"
  );
  process.stdout.write(
    "Verified Doudian alliance Skill source and canonical asset pins.\n"
  );
}

async function verifyPackage(inputPath) {
  let packageRoot = resolve(inputPath);
  let stage;
  if (packageRoot.endsWith(".zip")) {
    stage = await mkdtemp(join(tmpdir(), "bpa-skill-verify-"));
    await execFileAsync("unzip", ["-q", packageRoot, "-d", stage]);
    packageRoot = stage;
  }
  try {
    const required = [
      "SKILL.md",
      "agents/openai.yaml",
      "references/workbuddy-install-prompt.md",
      "references/workbuddy-automation-prompt.md",
      "scripts/Install-DoudianAllianceMonitor.ps1",
      "package-manifest.json"
    ];
    for (const relativePath of required) {
      await requireFile(join(packageRoot, relativePath), relativePath);
    }
    for (const [filename, canonicalPath] of Object.entries(canonicalAssets)) {
      const packagedPath = join(
        packageRoot,
        "assets/workflow-assets",
        filename
      );
      await requireFile(packagedPath, filename);
      if ((await digest(packagedPath)) !== (await digest(canonicalPath))) {
        throw new Error(`Packaged asset drifted from source: ${filename}`);
      }
    }
    const runtimeRoot = join(packageRoot, "assets/windows-x64");
    const runtimeFiles = (await readdir(runtimeRoot)).filter((name) =>
      /^bpa-local-.+-windows-x64\.zip$/u.test(name)
    );
    if (runtimeFiles.length !== 1) {
      throw new Error(
        "Skill package must contain exactly one Windows x64 Runtime"
      );
    }
    const runtimePath = join(runtimeRoot, runtimeFiles[0]);
    const checksumPath = `${runtimePath}.sha256`;
    await requireFile(checksumPath, "Runtime checksum");
    const expectedRuntimeDigest = (
      await readFile(checksumPath, "utf8")
    )
      .trim()
      .split(/\s+/u)[0]
      .toLowerCase();
    if ((await digest(runtimePath)) !== expectedRuntimeDigest) {
      throw new Error("Packaged Runtime checksum does not match");
    }
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package-manifest.json"), "utf8")
    );
    if (
      manifest.schemaVersion !== 1 ||
      manifest.kind !== "bpa.workbuddy-skill-delivery" ||
      manifest.runtime?.file !== basename(runtimePath) ||
      manifest.runtime?.sha256 !== expectedRuntimeDigest
    ) {
      throw new Error("Skill package manifest identity is invalid");
    }
    for (const entry of manifest.files ?? []) {
      const filePath = join(packageRoot, String(entry.path));
      await requireFile(filePath, String(entry.path));
      if ((await digest(filePath)) !== entry.sha256) {
        throw new Error(`Skill package file digest mismatch: ${entry.path}`);
      }
    }
    await execFileAsync(
      join(repositoryRoot, "scripts/verify-package-windows-x64.sh"),
      [runtimePath],
      {
        env: {
          ...process.env,
          BPA_BUNDLED_NODE: process.execPath
        },
        maxBuffer: 20 * 1024 * 1024
      }
    );
    process.stdout.write(
      `Verified complete Doudian alliance Skill delivery: ${inputPath}\n`
    );
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--source") {
  await verifySource();
} else if (args.length === 1) {
  await verifyPackage(args[0]);
} else {
  throw new Error(
    "Usage: verify-doudian-alliance-skill.mjs --source|<package-folder-or-zip>"
  );
}
