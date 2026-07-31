import { execFile } from "node:child_process";
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

const licenses = JSON.parse(await runPnpm(["licenses", "list", "--json"]));
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
  `Verified ${Object.keys(licenses).length} license expressions and dependency audit ` +
    `(${vulnerabilitySummary.critical ?? 0} critical, ${vulnerabilitySummary.high ?? 0} high; reviewed exceptions are current).\n`
);
