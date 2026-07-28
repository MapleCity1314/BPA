import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const issues = [];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function expectFileContains(path, expected, label) {
  const content = await readFile(path, "utf8");
  if (!content.includes(expected)) {
    issues.push(`${label} is not synchronized in ${relative(root, path)}`);
  }
}

function parseSkillFrontmatter(content, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) {
    issues.push(`Skill frontmatter is missing: ${relative(root, path)}`);
    return {};
  }
  try {
    return parse(match[1]) ?? {};
  } catch (error) {
    issues.push(
      `Skill frontmatter is invalid in ${relative(root, path)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {};
  }
}

async function verifyRuntimeVersions() {
  const rootPackage = await readJson(join(root, "package.json"));
  const version = rootPackage.version;
  const runtimePackages = [
    "apps/cli/package.json",
    "apps/extension/package.json",
    "apps/local-core/package.json",
    "apps/mcp-server/package.json",
    "apps/native-host/package.json"
  ];
  for (const packagePath of runtimePackages) {
    const packageJson = await readJson(join(root, packagePath));
    if (packageJson.version !== version) {
      issues.push(
        `${packagePath} version ${packageJson.version} does not match Runtime ${version}`
      );
    }
  }
  await expectFileContains(
    join(root, "apps/cli/src/main.ts"),
    `.version("${version}"`,
    "CLI version"
  );
  await expectFileContains(
    join(root, "apps/mcp-server/src/main.ts"),
    `version: "${version}"`,
    "MCP version"
  );
  await expectFileContains(
    join(root, "apps/extension/wxt.config.ts"),
    `version: "${version}"`,
    "Extension manifest version"
  );
  await expectFileContains(
    join(root, "scripts/install-macos-arm64.sh"),
    "manifest.release.identity",
    "Installer immutable release identity"
  );
  await expectFileContains(
    join(root, "scripts/package-macos-arm64.sh"),
    'RUNTIME_VERSION="$("$BUNDLED_NODE" -p \'require("./package.json").version\')"',
    "Package Runtime version source"
  );
  await expectFileContains(
    join(root, "scripts/package-macos-arm64.sh"),
    'EXPECTED_BASENAME="bpa-local-${RELEASE_IDENTITY}-macos-arm64.tar.gz"',
    "Package immutable release filename"
  );
  return version;
}

async function verifyAssets() {
  const nodeDirectory = join(root, "nodes/core");
  const nodeFiles = (await readdir(nodeDirectory))
    .filter((name) => name.endsWith(".node.yaml"))
    .sort();
  const nodeRefs = new Set();
  const nodesByRef = new Map();
  for (const filename of nodeFiles) {
    const path = join(nodeDirectory, filename);
    const node = parse(await readFile(path, "utf8"));
    if (node?.kind !== "Node" || !node?.metadata?.id || !node?.metadata?.version) {
      issues.push(`Malformed Node asset: ${relative(root, path)}`);
      continue;
    }
    const expectedFilename = `${node.metadata.id}.node.yaml`;
    const expectedVersionedFilename =
      `${node.metadata.id}@${node.metadata.version}.node.yaml`;
    if (
      filename !== expectedFilename &&
      filename !== expectedVersionedFilename
    ) {
      issues.push(
        `Node filename ${filename} must match ${expectedFilename} or ${expectedVersionedFilename}`
      );
    }
    const reference = `${node.metadata.id}@${node.metadata.version}`;
    if (nodeRefs.has(reference)) {
      issues.push(`Duplicate Node source identity: ${reference}`);
    }
    nodeRefs.add(reference);
    nodesByRef.set(reference, node);
  }

  const requiredDefaults = [
    "control.start@1.1.0",
    "control.succeed@1.1.0",
    "control.fail@1.0.0",
    "control.human-approval@1.1.0",
    "data.select@1.0.0",
    "data.merge@1.0.0"
  ];
  for (const reference of requiredDefaults) {
    if (!nodeRefs.has(reference)) {
      issues.push(`Required default Node source is missing: ${reference}`);
    }
  }

  const canonicalJson = (value) => {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(canonicalJson).join(",")}]`;
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  };
  const contentDigest = (value) =>
    `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
  const parseSourceAsset = async (path) => {
    const source = await readFile(path, "utf8");
    return extname(path) === ".json" ? JSON.parse(source) : parse(source);
  };
  const policyDirectory = join(root, "policies/core");
  const policies = new Map();
  for (const filename of (await readdir(policyDirectory)).sort()) {
    if (!filename.endsWith(".policy.json")) continue;
    const path = join(policyDirectory, filename);
    const policy = await parseSourceAsset(path);
    const reference = `${policy?.metadata?.id}@${policy?.metadata?.version}`;
    if (
      policy?.kind !== "DeterministicResultValidatorPolicy" ||
      !policy?.metadata?.id ||
      !policy?.metadata?.version
    ) {
      issues.push(`Malformed Policy asset: ${relative(root, path)}`);
      continue;
    }
    if (filename !== `${policy.metadata.id}.policy.json`) {
      issues.push(
        `Policy filename ${filename} must match identity ${policy.metadata.id}.policy.json`
      );
    }
    if (policies.has(reference)) {
      issues.push(`Duplicate Policy source identity: ${reference}`);
    }
    policies.set(reference, {
      definition: policy,
      digest: contentDigest(policy)
    });
  }
  const assistanceDirectory = join(root, "assistance-profiles/core");
  const assistanceProfiles = new Map();
  for (const filename of (await readdir(assistanceDirectory)).sort()) {
    if (
      !filename.endsWith(".assistance-profile.json") &&
      !filename.endsWith(".assistance-profile.yaml")
    ) {
      continue;
    }
    const path = join(assistanceDirectory, filename);
    const profile = await parseSourceAsset(path);
    const reference = `${profile?.metadata?.id}@${profile?.metadata?.version}`;
    if (
      profile?.kind !== "AssistanceProfile" ||
      !profile?.metadata?.id ||
      !profile?.metadata?.version
    ) {
      issues.push(`Malformed Assistance Profile asset: ${relative(root, path)}`);
      continue;
    }
    const suffix = extname(filename);
    if (
      filename !==
      `${profile.metadata.id}.assistance-profile${suffix}`
    ) {
      issues.push(
        `Assistance Profile filename ${filename} does not match ${profile.metadata.id}`
      );
    }
    if (assistanceProfiles.has(reference)) {
      issues.push(`Duplicate Assistance Profile source identity: ${reference}`);
    }
    assistanceProfiles.set(reference, profile);
    const validator = profile.policySnapshot?.deterministicValidator;
    if (validator) {
      const policy = policies.get(`${validator.id}@${validator.version}`);
      if (!policy || policy.digest !== validator.digest) {
        issues.push(
          `${reference} does not pin an exact source deterministic validator Policy`
        );
      }
    }
  }

  const workflowDirectory = join(root, "workflows/examples");
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((name) => name.endsWith(".workflow.yaml"))
    .sort();
  const workflowRefs = new Set();
  const riskScore = (risk) =>
    ["R0", "R1", "R2", "R3", "R4"].indexOf(String(risk));
  function verifyStructuredBlock(reference, workflowRisk, block, path) {
    for (const step of block?.steps ?? []) {
      const stepPath = `${path}.${String(step?.key ?? "?")}`;
      if (step?.kind === "call") {
        if (typeof step.use !== "string" || !nodeRefs.has(step.use)) {
          issues.push(
            `${reference} step ${stepPath} references missing source Node ${String(
              step?.use
            )}`
          );
        }
        const node = nodesByRef.get(step.use);
        if (
          node &&
          riskScore(workflowRisk) < riskScore(node.risk?.level)
        ) {
          issues.push(
            `${reference} risk ${workflowRisk} is below ${step.use} risk ${node.risk?.level}`
          );
        }
      }
      if (step?.kind === "wait.assistance") {
        const profile = assistanceProfiles.get(step.use);
        if (!profile) {
          issues.push(
            `${reference} step ${stepPath} references missing Assistance Profile ${String(
              step.use
            )}`
          );
        } else if (
          riskScore(workflowRisk) < riskScore(profile.riskLevel)
        ) {
          issues.push(
            `${reference} risk ${workflowRisk} is below ${step.use} risk ${profile.riskLevel}`
          );
        }
      }
      if (step?.kind === "decision") {
        verifyStructuredBlock(
          reference,
          workflowRisk,
          step.then,
          `${stepPath}.then`
        );
        verifyStructuredBlock(
          reference,
          workflowRisk,
          step.else,
          `${stepPath}.else`
        );
      }
      if (step?.kind === "foreach") {
        verifyStructuredBlock(
          reference,
          workflowRisk,
          step.body,
          `${stepPath}.body`
        );
      }
      for (const [outcome, handler] of Object.entries(step?.handlers ?? {})) {
        verifyStructuredBlock(
          reference,
          workflowRisk,
          handler,
          `${stepPath}.handlers.${outcome}`
        );
      }
    }
  }
  for (const filename of workflowFiles) {
    const path = join(workflowDirectory, filename);
    const workflow = parse(await readFile(path, "utf8"));
    if (
      workflow?.kind !== "Workflow" ||
      !workflow?.metadata?.id ||
      !workflow?.metadata?.version
    ) {
      issues.push(`Malformed Workflow asset: ${relative(root, path)}`);
      continue;
    }
    const expectedFilename = `${workflow.metadata.id}.workflow.yaml`;
    if (filename !== expectedFilename) {
      issues.push(
        `Workflow filename ${filename} must match identity ${expectedFilename}`
      );
    }
    const reference = `${workflow.metadata.id}@${workflow.metadata.version}`;
    if (workflowRefs.has(reference)) {
      issues.push(`Duplicate Workflow source identity: ${reference}`);
    }
    workflowRefs.add(reference);
    if (workflow.apiVersion === "bpa/v1alpha2") {
      verifyStructuredBlock(
        reference,
        workflow.spec?.riskLevel,
        workflow.spec?.root,
        "root"
      );
    } else {
      for (const [key, step] of Object.entries(workflow.spec?.nodes ?? {})) {
        if (typeof step?.use !== "string" || !nodeRefs.has(step.use)) {
          issues.push(
            `${reference} step ${key} references missing source Node ${String(
              step?.use
            )}`
          );
        }
      }
    }
  }

  const adapterDirectory = join(root, "adapters");
  const adapterFiles = [];
  for (const entry of await readdir(adapterDirectory, {
    withFileTypes: true
  })) {
    if (!entry.isDirectory()) continue;
    const directory = join(adapterDirectory, entry.name);
    for (const filename of await readdir(directory)) {
      if (filename.endsWith(".adapter.yaml")) {
        adapterFiles.push(join(directory, filename));
      }
    }
  }
  const adapterRefs = new Set();
  for (const path of adapterFiles.sort()) {
    const adapter = parse(await readFile(path, "utf8"));
    const reference = `${String(adapter?.metadata?.id)}@${String(
      adapter?.metadata?.version
    )}`;
    const expectedFilename = `${adapter?.metadata?.id}.adapter.yaml`;
    if (
      adapter?.kind !== "Adapter" ||
      !adapter?.metadata?.id ||
      !adapter?.metadata?.version
    ) {
      issues.push(`Malformed Adapter asset: ${relative(root, path)}`);
      continue;
    }
    if (basename(path) !== expectedFilename) {
      issues.push(
        `Adapter filename ${basename(path)} must match identity ${expectedFilename}`
      );
    }
    if (adapterRefs.has(reference)) {
      issues.push(`Duplicate Adapter source identity: ${reference}`);
    }
    adapterRefs.add(reference);
    const origins = new Set(adapter.origins ?? []);
    for (const capability of adapter.capabilities ?? []) {
      for (const version of capability.nodeVersions ?? []) {
        const nodeReference = `${capability.nodeId}@${version}`;
        const node = nodesByRef.get(nodeReference);
        if (!node || node.runtime !== "browser") {
          issues.push(
            `${reference} references missing Browser Node ${nodeReference}`
          );
          continue;
        }
        if (
          node.adapter?.id !== adapter.metadata.id ||
          !node.adapter?.versions?.includes(adapter.metadata.version)
        ) {
          issues.push(
            `${nodeReference} does not pin source Adapter ${reference}`
          );
        }
        if (
          JSON.stringify([...(node.risk?.permissions ?? [])].sort()) !==
          JSON.stringify([...(capability.permissions ?? [])].sort())
        ) {
          issues.push(
            `${reference} capability permissions differ from ${nodeReference}`
          );
        }
        for (const origin of node.risk?.domains ?? []) {
          if (!origins.has(origin)) {
            issues.push(
              `${reference} origin allowlist is missing ${origin} for ${nodeReference}`
            );
          }
        }
      }
    }
  }
  return {
    nodeCount: nodeRefs.size,
    workflowCount: workflowRefs.size,
    adapterCount: adapterRefs.size,
    assistanceProfileCount: assistanceProfiles.size,
    policyCount: policies.size
  };
}

async function verifySkills() {
  const skillRoot = join(root, "skills");
  const directories = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const skillName of directories) {
    const directory = join(skillRoot, skillName);
    const skillPath = join(directory, "SKILL.md");
    const agentPath = join(directory, "agents/openai.yaml");
    if (!(await exists(skillPath))) {
      issues.push(`Skill entrypoint is missing: skills/${skillName}/SKILL.md`);
      continue;
    }
    const content = await readFile(skillPath, "utf8");
    const metadata = parseSkillFrontmatter(content, skillPath);
    if (metadata.name !== skillName) {
      issues.push(
        `Skill name ${String(metadata.name)} does not match directory ${skillName}`
      );
    }
    if (
      typeof metadata.description !== "string" ||
      metadata.description.trim().length < 20
    ) {
      issues.push(`Skill description is too weak: skills/${skillName}`);
    }
    if (/\b(?:TODO|FIXME|TBD)\b/i.test(content)) {
      issues.push(`Skill contains an unfinished marker: skills/${skillName}`);
    }
    if (!(await exists(agentPath))) {
      issues.push(`Skill agent metadata is missing: skills/${skillName}`);
    } else {
      const agent = parse(await readFile(agentPath, "utf8"));
      const prompt = agent?.interface?.default_prompt;
      if (typeof prompt !== "string" || !prompt.includes(`$${skillName}`)) {
        issues.push(
          `Skill default prompt must mention $${skillName}: ${relative(
            root,
            agentPath
          )}`
        );
      }
      const shortDescription = agent?.interface?.short_description;
      if (
        typeof shortDescription !== "string" ||
        shortDescription.length < 10 ||
        shortDescription.length > 64
      ) {
        issues.push(
          `Skill short_description must be 10-64 characters: ${relative(
            root,
            agentPath
          )}`
        );
      }
    }

    const markdownLinks = [
      ...content.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)
    ];
    for (const match of markdownLinks) {
      const target = match[1].split("#", 1)[0];
      const resolved = resolve(dirname(skillPath), target);
      if (!(await exists(resolved))) {
        issues.push(
          `Broken Skill reference ${target}: ${relative(root, skillPath)}`
        );
      }
    }
  }
  return directories.length;
}

async function verifyScripts() {
  const scriptDirectory = join(root, "scripts");
  const shellScripts = (await readdir(scriptDirectory))
    .filter((name) => name.endsWith(".sh"))
    .sort();
  for (const filename of shellScripts) {
    const path = join(scriptDirectory, filename);
    const fileStat = await stat(path);
    if ((fileStat.mode & 0o111) === 0) {
      issues.push(`Shell script is not executable: scripts/${filename}`);
    }
  }
  return shellScripts.length;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (
      [".ts", ".tsx", ".mts", ".js", ".mjs"].includes(extname(path))
    ) {
      files.push(path);
    }
  }
  return files;
}

function importedSpecifiers(content) {
  const imports = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

async function verifyDependencyBoundaries() {
  const sourceRoots = ["apps", "packages", "adapters"];
  const files = [];
  for (const sourceRoot of sourceRoots) {
    const directory = join(root, sourceRoot);
    if (await exists(directory)) files.push(...(await sourceFiles(directory)));
  }

  for (const path of files) {
    const repositoryPath = relative(root, path);
    const content = await readFile(path, "utf8");
    for (const specifier of importedSpecifiers(content)) {
      if (/^@bpa\/[^/]+\/src(?:\/|$)/.test(specifier)) {
        issues.push(
          `Private package source import is forbidden: ${repositoryPath} -> ${specifier}`
        );
      }
      if (
        repositoryPath.startsWith("packages/") &&
        specifier.startsWith(".") &&
        relative(root, resolve(dirname(path), specifier)).startsWith("apps/")
      ) {
        issues.push(
          `Package cannot import an App: ${repositoryPath} -> ${specifier}`
        );
      }
      if (
        (repositoryPath.startsWith("apps/cli/") ||
          repositoryPath.startsWith("apps/mcp-server/")) &&
        specifier.startsWith("@bpa/local-core")
      ) {
        issues.push(
          `Control client must not import Local Core: ${repositoryPath} -> ${specifier}`
        );
      }
      if (
        repositoryPath.startsWith("packages/engine/") &&
        ([
          "@bpa/compiler",
          "@bpa/persistence-sqlite",
          "@bpa/control-client"
        ].includes(specifier) ||
          /(?:chrome|mcp|doudian)/i.test(specifier))
      ) {
        issues.push(
          `Engine dependency boundary violated: ${repositoryPath} -> ${specifier}`
        );
      }
    }
  }

  const packageDirectories = (await readdir(join(root, "packages"), {
    withFileTypes: true
  })).filter((entry) => entry.isDirectory());
  for (const entry of packageDirectories) {
    if (entry.name === "schemas") continue;
    const packagePath = join(root, "packages", entry.name, "package.json");
    const packageJson = await readJson(packagePath);
    const exportKeys = Object.keys(packageJson.exports ?? {});
    if (exportKeys.length !== 1 || exportKeys[0] !== ".") {
      issues.push(
        `Package must expose one public entrypoint: packages/${entry.name}/package.json`
      );
    }
  }
  return files.length;
}

const runtimeVersion = await verifyRuntimeVersions();
const assets = await verifyAssets();
const skillCount = await verifySkills();
const shellScriptCount = await verifyScripts();
const sourceFileCount = await verifyDependencyBoundaries();

if (issues.length > 0) {
  process.stderr.write(
    `Repository verification failed:\n${issues
      .map((issue) => `- ${issue}`)
      .join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Repository verified: Runtime ${runtimeVersion}, ${assets.nodeCount} Nodes, ${assets.workflowCount} Workflows, ${assets.adapterCount} Adapters, ${assets.assistanceProfileCount} Assistance Profiles, ${assets.policyCount} Policies, ${skillCount} Skills, ${shellScriptCount} shell scripts, ${sourceFileCount} dependency-checked source files.\n`
  );
}
