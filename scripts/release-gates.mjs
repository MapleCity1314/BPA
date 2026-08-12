import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const NODE_VERSION_PATTERN =
  /^24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_IDENTITY_PATTERN =
  /^v(?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-rc\.(?<commit>[a-f0-9]{12})\.node(?<node>24\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;

const SENSITIVE_PATTERNS = [
  {
    code: "PRIVATE_KEY",
    expression:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gu
  },
  {
    code: "AWS_ACCESS_KEY",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu
  },
  {
    code: "GITHUB_TOKEN",
    expression: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu
  },
  {
    code: "SLACK_TOKEN",
    expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu
  },
  {
    code: "OPENAI_TOKEN",
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu
  },
  {
    code: "JWT",
    expression:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu
  },
  {
    code: "LITERAL_SECRET_ASSIGNMENT",
    expression:
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/giu
  },
  {
    code: "URL_CREDENTIALS",
    expression:
      /\bhttps?:\/\/[^/\s:@]{2,}:[^/\s@]{8,}@[A-Za-z0-9.-]+/giu
  }
];

function requireMatch(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid: ${String(value)}`);
  }
  return value;
}

export function createReleaseMetadata(input) {
  const runtimeVersion = requireMatch(
    input.runtimeVersion,
    VERSION_PATTERN,
    "Runtime version"
  );
  const gitCommit = requireMatch(
    input.gitCommit,
    GIT_COMMIT_PATTERN,
    "Git commit"
  );
  const nodeVersion = requireMatch(
    input.nodeVersion,
    NODE_VERSION_PATTERN,
    "Node.js version"
  );
  const supported =
    (input.platform === "darwin" && input.architecture === "arm64") ||
    (input.platform === "win32" && input.architecture === "x64");
  if (!supported) {
    throw new Error(
      `Release platform must be darwin-arm64 or win32-x64, received ${input.platform}-${input.architecture}`
    );
  }
  return {
    identity: `v${runtimeVersion}-rc.${gitCommit.slice(0, 12)}.node${nodeVersion}`,
    channel: "rc",
    runtimeVersion,
    gitCommit,
    nodeVersion,
    platform: input.platform,
    architecture: input.architecture
  };
}

export function validateReleaseMetadata(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Release metadata is missing");
  }
  const expected = createReleaseMetadata(candidate);
  if (
    candidate.identity !== expected.identity ||
    candidate.channel !== expected.channel
  ) {
    throw new Error("Release identity does not match its immutable inputs");
  }
  const identity = candidate.identity.match(RELEASE_IDENTITY_PATTERN);
  if (
    !identity?.groups ||
    identity.groups.version !== candidate.runtimeVersion ||
    identity.groups.commit !== candidate.gitCommit.slice(0, 12) ||
    identity.groups.node !== candidate.nodeVersion
  ) {
    throw new Error("Release identity is malformed");
  }
  return expected;
}

export function expectedArchiveBasename(release) {
  const exact = validateReleaseMetadata(release);
  return exact.platform === "darwin"
    ? `bpa-local-${exact.identity}-macos-${exact.architecture}.tar.gz`
    : `bpa-local-${exact.identity}-windows-${exact.architecture}.zip`;
}

export function assertArchiveBasename(name, release) {
  const expected = expectedArchiveBasename(release);
  if (basename(name) !== expected) {
    throw new Error(
      `Release archive must be named ${expected}; refusing legacy or mismatched archive ${basename(name)}`
    );
  }
  return expected;
}

export function sensitiveContentFindings(bytes, path = "<memory>") {
  if (Buffer.isBuffer(bytes) && bytes.subarray(0, 8_192).includes(0)) {
    return [];
  }
  const text = Buffer.isBuffer(bytes)
    ? bytes.toString("utf8")
    : String(bytes);
  const findings = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(text)) {
      findings.push({ code: pattern.code, path });
    }
  }
  return findings;
}

export async function scanReleaseTree(root) {
  const findings = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const releasePath = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        findings.push(
          ...sensitiveContentFindings(await readFile(path), releasePath)
        );
      } else {
        throw new Error(
          `Release content must contain regular files only: ${releasePath}`
        );
      }
    }
  }
  await visit(root);
  return findings;
}

export function formatSensitiveFindings(findings) {
  return findings.map((finding) => `${finding.code}:${finding.path}`).join(", ");
}
