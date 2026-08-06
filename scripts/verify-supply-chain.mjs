import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const policy = JSON.parse(
  await readFile(resolve(root, "config/supply-chain-policy.json"), "utf8")
);
const severityRank = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4]
]);
const today = new Date().toISOString().slice(0, 10);

function assertCurrentException(exception, label) {
  if (!exception.owner || !exception.reason || !exception.expiresOn) {
    throw new Error(`${label} must have an owner, reason, and expiry date`);
  }
  if (exception.expiresOn < today) {
    throw new Error(`${label} expired on ${exception.expiresOn}`);
  }
}

async function runPnpm(args, allowFailure = false) {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) {
    throw new Error("Run this verifier through `pnpm supply-chain:check`");
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [pnpmEntry, ...args],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 }
    );
    return stdout;
  } catch (error) {
    if (allowFailure && error.stdout) return error.stdout;
    throw error;
  }
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    value.type.trim()
  ) {
    return value.type.trim();
  }
  return undefined;
}

function mergeInstalledOptionalLicenses(licenses, projects) {
  const knownIdentities = new Set(
    Object.values(licenses).flatMap((packages) =>
      packages.flatMap((entry) =>
        (entry.versions ?? []).map((version) => `${entry.name}@${version}`)
      )
    )
  );
  const installedPackages = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    const name = typeof value.from === "string" ? value.from : undefined;
    const version = typeof value.version === "string" ? value.version : undefined;
    const path = typeof value.path === "string" ? value.path : "";
    if (
      name &&
      version &&
      /(?:^|[\\/])node_modules(?:[\\/]|$)/u.test(path) &&
      existsSync(path)
    ) {
      const identity = `${name}@${version}`;
      const license = normalizeLicense(value.license);
      const current = installedPackages.get(identity);
      if (!current || (!current.license && license)) {
        installedPackages.set(identity, { name, version, path, license });
      }
    }
    for (const dependencyGroup of [
      value.dependencies,
      value.devDependencies,
      value.optionalDependencies
    ]) {
      if (!dependencyGroup || typeof dependencyGroup !== "object") continue;
      for (const dependency of Object.values(dependencyGroup)) visit(dependency);
    }
  };
  visit(projects);

  for (const [identity, installed] of installedPackages) {
    if (knownIdentities.has(identity)) continue;
    if (!installed.license) {
      throw new Error(`Installed dependency ${identity} has no declared license`);
    }
    const packages = licenses[installed.license] ?? [];
    packages.push({
      name: installed.name,
      versions: [installed.version],
      paths: [installed.path],
      license: installed.license
    });
    licenses[installed.license] = packages;
    knownIdentities.add(identity);
  }
  return knownIdentities.size;
}

const licenses = JSON.parse(
  await runPnpm(["licenses", "list", "--json", "--no-optional"])
);
const installedProjects = JSON.parse(
  await runPnpm(["--recursive", "list", "--json", "--long", "--depth", "Infinity"])
);
const dependencyIdentityCount = mergeInstalledOptionalLicenses(
  licenses,
  installedProjects
);
const allowedLicenses = new Set(policy.allowedLicenses);
for (const [license, packages] of Object.entries(licenses)) {
  if (allowedLicenses.has(license)) continue;
  const exception = policy.licenseExceptions.find(
    (candidate) => candidate.license === license
  );
  assertCurrentException(exception ?? {}, `License exception for ${license}`);
  const allowedPackages = new Set(exception.packages);
  const unexpected = packages
    .map((entry) => entry.name)
    .filter((name) => !allowedPackages.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Unreviewed ${license} packages: ${unexpected.join(", ")}`
    );
  }
}

const audit = JSON.parse(
  await runPnpm(
    ["audit", "--json", "--registry", policy.auditRegistry],
    true
  )
);
if (audit.error) {
  throw new Error(`Dependency audit failed: ${audit.error.message}`);
}
const minimumRank = severityRank.get(policy.minimumBlockedSeverity);
for (const advisory of Object.values(audit.advisories ?? {})) {
  if ((severityRank.get(advisory.severity) ?? 0) < minimumRank) continue;
  const advisoryId = String(advisory.url).split("/").at(-1);
  const exception = policy.vulnerabilityExceptions.find(
    (candidate) =>
      candidate.advisory === advisoryId &&
      candidate.module === advisory.module_name
  );
  assertCurrentException(
    exception ?? {},
    `Vulnerability exception for ${advisoryId}`
  );
  const paths = advisory.findings.flatMap((finding) => finding.paths ?? []);
  if (
    paths.length === 0 ||
    paths.some((path) => !path.startsWith(exception.allowedPathPrefix))
  ) {
    throw new Error(
      `${advisoryId} escaped its reviewed dependency path: ${paths.join(", ")}`
    );
  }
}

const vulnerabilitySummary = audit.metadata?.vulnerabilities ?? {};
process.stdout.write(
  `Verified ${Object.keys(licenses).length} license expressions across ` +
    `${dependencyIdentityCount} dependency identities and dependency audit ` +
    `(${vulnerabilitySummary.critical ?? 0} critical, ${vulnerabilitySummary.high ?? 0} high; reviewed exceptions are current).\n`
);
