import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
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
  "doudian.alliance.shop.retired-products.fact.persist.node.yaml": join(
    repositoryRoot,
    "nodes/core/doudian.alliance.shop.retired-products.fact.persist.node.yaml"
  ),
  "doudian.alliance.retired-products.aggregate.node.yaml": join(
    repositoryRoot,
    "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml"
  ),
  "doudian.alliance.retired-products.dataset.prepare.node.yaml": join(
    repositoryRoot,
    "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml"
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

async function requireCanonicalLf(path, label) {
  const bytes = await readFile(path);
  if (bytes.includes(Buffer.from("\r\n"))) {
    throw new Error(
      `${label} uses CRLF; release identities require canonical LF bytes`
    );
  }
}

async function requireUtf8Bom(path, label) {
  const bytes = await readFile(path);
  if (
    bytes.length < 3 ||
    bytes[0] !== 0xef ||
    bytes[1] !== 0xbb ||
    bytes[2] !== 0xbf
  ) {
    throw new Error(`${label} must use UTF-8 BOM for Windows PowerShell 5.1`);
  }
}

async function requireFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function safePackagePath(path) {
  const parts = typeof path === "string" ? path.split("/") : [];
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) &&
        part !== "." &&
        part !== ".." &&
        !part.endsWith(".") &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(part)
    )
  );
}

async function verifyWorkBuddyBoundaries(root) {
  const installPrompt = await readFile(
    join(root, "references/workbuddy-install-prompt.md"),
    "utf8"
  );
  const automationPrompt = await readFile(
    join(root, "references/workbuddy-automation-prompt.md"),
    "utf8"
  );
  for (const requiredInstruction of [
    "不读取、对比或分析 Runtime 内部 JavaScript、PowerShell、Workflow 或扩展 bundle",
    "不创建 `.mjs`、`.js`、`.ps1` 补丁",
    "不得继续猜测或检查脚本逻辑",
    "只有安装器自身返回 `ready` 才能宣告完成",
    "`acceptance.recordVerified=true`"
  ]) {
    if (!installPrompt.includes(requiredInstruction)) {
      throw new Error(
        `WorkBuddy install safety boundary is missing: ${requiredInstruction}`
      );
    }
  }
  for (const requiredInstruction of [
    "不得自己编写或修改临时脚本、选择器、Session ID 或运行参数",
    "不得检查 Runtime、扩展或 Workflow 的源码来临时修复运行失败",
    "固定入口返回异常时只按结构化错误提醒运营，停止本轮任务"
  ]) {
    if (!automationPrompt.includes(requiredInstruction)) {
      throw new Error(
        `WorkBuddy automation safety boundary is missing: ${requiredInstruction}`
      );
    }
  }
}

async function filesUnder(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Skill package must not contain symlinks: ${path}`);
    }
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(root, path)));
    } else if (entry.isFile()) {
      result.push(relative(root, path).replaceAll("\\", "/"));
    } else {
      throw new Error(`Unsupported Skill package entry: ${path}`);
    }
  }
  return result.sort();
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
  await verifyWorkBuddyBoundaries(skillSource);
  const installer = await readFile(
    join(skillSource, "scripts/Install-DoudianAllianceMonitor.ps1"),
    "utf8"
  );
  await requireUtf8Bom(
    join(skillSource, "scripts/Install-DoudianAllianceMonitor.ps1"),
    "Doudian alliance installer"
  );
  for (const [filename, path] of Object.entries(canonicalAssets)) {
    await requireCanonicalLf(path, filename);
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
  if (
    Object.keys(canonicalAssets).length !== 7 ||
    !installer.includes(
      'workflow = "doudian.alliance-retired-products-monitor@3.0.14"'
    ) ||
    !installer.includes('"--version", "3.0.14"') ||
    !installer.includes("foreach ($Asset in $RequiredAssets)")
  ) {
    throw new Error(
      "Installer must publish the seven-asset Workflow 3 closure through the real runner"
    );
  }
  const promptDigest = await digest(
    join(skillSource, "references/workbuddy-automation-prompt.md")
  );
  await requireCanonicalLf(
    join(skillSource, "references/workbuddy-automation-prompt.md"),
    "WorkBuddy automation prompt"
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
    const archivePath = packageRoot;
    const archiveChecksumPath = `${archivePath}.sha256`;
    await requireFile(archiveChecksumPath, "Skill archive checksum");
    const checksumFields = (await readFile(archiveChecksumPath, "ascii"))
      .trim()
      .split(/\s+/u);
    if (
      checksumFields.length !== 2 ||
      checksumFields[1] !== basename(archivePath) ||
      checksumFields[0]?.toLowerCase() !== (await digest(archivePath))
    ) {
      throw new Error("Skill archive checksum or filename does not match");
    }
    const archiveListing = (
      await execFileAsync("unzip", ["-Z1", archivePath], {
        maxBuffer: 2 * 1024 * 1024
      })
    ).stdout
      .split(/\r?\n/u)
      .filter(Boolean);
    const archivePaths = archiveListing
      .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path))
      .filter(Boolean);
    const archiveFiles = archiveListing.filter((path) => !path.endsWith("/"));
    if (
      archiveFiles.length === 0 ||
      archivePaths.some((path) => !safePackagePath(path)) ||
      new Set(archiveFiles).size !== archiveFiles.length
    ) {
      throw new Error("Skill archive contains unsafe or duplicate paths");
    }
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
    await verifyWorkBuddyBoundaries(packageRoot);
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
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error("Skill package manifest file closure is missing");
    }
    const manifestPaths = new Set();
    for (const entry of manifest.files) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !safePackagePath(entry.path) ||
        !/^[a-f0-9]{64}$/u.test(String(entry.sha256)) ||
        manifestPaths.has(entry.path) ||
        entry.path === "package-manifest.json"
      ) {
        throw new Error(
          "Skill package manifest contains an invalid file entry"
        );
      }
      manifestPaths.add(entry.path);
      const filePath = join(packageRoot, String(entry.path));
      await requireFile(filePath, String(entry.path));
      if ((await digest(filePath)) !== entry.sha256) {
        throw new Error(`Skill package file digest mismatch: ${entry.path}`);
      }
    }
    const actualFiles = (await filesUnder(packageRoot)).filter(
      (path) => path !== "package-manifest.json"
    );
    if (
      actualFiles.length !== manifestPaths.size ||
      actualFiles.some((path) => !manifestPaths.has(path))
    ) {
      throw new Error(
        "Skill package contains files outside the manifest closure"
      );
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
      `Verified complete Doudian alliance Skill delivery and checksum: ${inputPath}\n`
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
