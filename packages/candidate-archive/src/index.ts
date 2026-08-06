import { createHash } from "node:crypto";

const BLOCK_SIZE = 512;
const SAFE_PATH =
  /^(?:candidate-manifest\.json|candidate\.patch|validation-report\.json|risk-report\.json|checksums\.sha256|files\/(?:adapters|nodes|workflows|tests)\/[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*)$/u;

export interface CandidateArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

export interface CandidateArchiveVerification {
  valid: boolean;
  archiveDigest: string;
  entries: Array<{
    path: string;
    digest: string;
    sizeBytes: number;
  }>;
  manifest?: Record<string, unknown>;
  issues: string[];
}

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertSafePath(path: string): void {
  if (
    !SAFE_PATH.test(path) ||
    path.includes("..") ||
    path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > 255
  ) {
    throw new Error(`Unsafe Candidate archive path: ${path}`);
  }
}

function writeString(
  target: Buffer,
  offset: number,
  length: number,
  value: string
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) {
    throw new Error(`Tar field exceeds ${length} bytes`);
  }
  bytes.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) {
    throw new Error("Tar numeric field overflow");
  }
  writeString(target, offset, length, `${encoded}\0`);
}

function splitTarPath(path: string): {
  name: string;
  prefix?: string;
} {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path };
  const segments = path.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Candidate archive path cannot be represented in ustar: ${path}`);
}

function header(path: string, size: number): Buffer {
  const split = splitTarPath(path);
  const result = Buffer.alloc(BLOCK_SIZE);
  writeString(result, 0, 100, split.name);
  writeOctal(result, 100, 8, 0o644);
  writeOctal(result, 108, 8, 0);
  writeOctal(result, 116, 8, 0);
  writeOctal(result, 124, 12, size);
  writeOctal(result, 136, 12, 0);
  result.fill(0x20, 148, 156);
  result[156] = "0".charCodeAt(0);
  writeString(result, 257, 6, "ustar\0");
  writeString(result, 263, 2, "00");
  if (split.prefix) writeString(result, 345, 155, split.prefix);
  const checksum = result.reduce((sum, byte) => sum + byte, 0);
  writeString(
    result,
    148,
    8,
    `${checksum.toString(8).padStart(6, "0")}\0 `
  );
  return result;
}

function checksums(entries: readonly CandidateArchiveEntry[]): Buffer {
  return Buffer.from(
    `${entries
      .map((entry) => `${sha256(entry.bytes)}  ${entry.path}`)
      .join("\n")}\n`,
    "utf8"
  );
}

export function createCandidateArchive(
  inputEntries: readonly CandidateArchiveEntry[]
): Uint8Array {
  const seen = new Set<string>();
  const entries = inputEntries
    .map((entry) => ({
      path: entry.path,
      bytes: Buffer.from(entry.bytes)
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const entry of entries) {
    assertSafePath(entry.path);
    if (
      entry.path === "checksums.sha256" ||
      seen.has(entry.path)
    ) {
      throw new Error(`Duplicate or reserved Candidate archive path: ${entry.path}`);
    }
    seen.add(entry.path);
  }
  const complete = [
    ...entries,
    {
      path: "checksums.sha256",
      bytes: checksums(entries)
    }
  ];
  const blocks: Buffer[] = [];
  for (const entry of complete) {
    blocks.push(header(entry.path, entry.bytes.byteLength));
    blocks.push(entry.bytes);
    const remainder = entry.bytes.byteLength % BLOCK_SIZE;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(BLOCK_SIZE - remainder));
    }
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

function readNullTerminated(
  bytes: Uint8Array,
  offset: number,
  length: number
): string {
  const field = Buffer.from(bytes.subarray(offset, offset + length));
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function parseOctal(
  bytes: Uint8Array,
  offset: number,
  length: number
): number {
  const value = readNullTerminated(bytes, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Invalid tar octal field");
  return Number.parseInt(value, 8);
}

function parseArchive(bytes: Uint8Array): CandidateArchiveEntry[] {
  const entries: CandidateArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + BLOCK_SIZE <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (block.every((byte) => byte === 0)) break;
    const storedChecksum = parseOctal(block, 148, 8);
    const checksumBlock = Buffer.from(block);
    checksumBlock.fill(0x20, 148, 156);
    const actualChecksum = checksumBlock.reduce(
      (sum, byte) => sum + byte,
      0
    );
    if (storedChecksum !== actualChecksum) {
      throw new Error("Tar header checksum mismatch");
    }
    if (block[156] !== "0".charCodeAt(0) && block[156] !== 0) {
      throw new Error("Candidate archive contains a non-regular entry");
    }
    const name = readNullTerminated(block, 0, 100);
    const prefix = readNullTerminated(block, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafePath(path);
    if (seen.has(path)) {
      throw new Error(`Duplicate Candidate archive entry: ${path}`);
    }
    seen.add(path);
    const size = parseOctal(block, 124, 12);
    const bodyStart = offset + BLOCK_SIZE;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.byteLength) {
      throw new Error(`Truncated Candidate archive entry: ${path}`);
    }
    entries.push({
      path,
      bytes: bytes.slice(bodyStart, bodyEnd)
    });
    offset =
      bodyStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

export function verifyCandidateArchive(
  bytes: Uint8Array
): CandidateArchiveVerification {
  const issues: string[] = [];
  let entries: CandidateArchiveEntry[] = [];
  try {
    entries = parseArchive(bytes);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const required of [
    "candidate-manifest.json",
    "candidate.patch",
    "validation-report.json",
    "risk-report.json",
    "checksums.sha256"
  ]) {
    if (!byPath.has(required)) {
      issues.push(`Missing required Candidate archive entry: ${required}`);
    }
  }
  const checksumEntry = byPath.get("checksums.sha256");
  if (checksumEntry) {
    const declared = new Map<string, string>();
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(checksumEntry.bytes)
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const match = /^(sha256:[a-f0-9]{64}) {2}(.+)$/u.exec(line);
      if (!match) {
        issues.push("Invalid checksums.sha256 line");
        continue;
      }
      declared.set(match[2]!, match[1]!);
    }
    for (const entry of entries) {
      if (entry.path === "checksums.sha256") continue;
      if (declared.get(entry.path) !== sha256(entry.bytes)) {
        issues.push(`Checksum mismatch: ${entry.path}`);
      }
    }
    if (declared.size !== entries.length - 1) {
      issues.push("checksums.sha256 does not describe the exact archive entry set");
    }
  }
  let manifest: Record<string, unknown> | undefined;
  const manifestEntry = byPath.get("candidate-manifest.json");
  if (manifestEntry) {
    try {
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          manifestEntry.bytes
        )
      ) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("manifest must be an object");
      }
      manifest = parsed as Record<string, unknown>;
    } catch (error) {
      issues.push(
        `Invalid candidate-manifest.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return {
    valid: issues.length === 0,
    archiveDigest: sha256(bytes),
    entries: entries.map((entry) => ({
      path: entry.path,
      digest: sha256(entry.bytes),
      sizeBytes: entry.bytes.byteLength
    })),
    ...(manifest ? { manifest } : {}),
    issues
  };
}

export function createCandidatePatch(
  files: readonly CandidateArchiveEntry[]
): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path, "en"))
    .map((file) => {
      assertSafePath(`files/${file.path}`);
      const body = decoder.decode(file.bytes).replace(/\r\n/gu, "\n");
      const lines = body.endsWith("\n")
        ? body.slice(0, -1).split("\n")
        : body.split("\n");
      return [
        `diff --git a/${file.path} b/${file.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`)
      ].join("\n");
    })
    .join("\n");
}
