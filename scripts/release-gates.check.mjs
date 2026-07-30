import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertArchiveBasename,
  createReleaseMetadata,
  expectedArchiveBasename,
  scanReleaseTree,
  sensitiveContentFindings,
  validateReleaseMetadata
} from "./release-gates.mjs";

const commit = "45012e05d9326bc96156c10d43c7614e7600fb28";

test("derives one deterministic RC identity from exact release inputs", () => {
  const release = createReleaseMetadata({
    runtimeVersion: "0.4.0",
    gitCommit: commit,
    nodeVersion: "24.18.0",
    platform: "darwin",
    architecture: "arm64"
  });
  assert.deepEqual(validateReleaseMetadata(release), release);
  assert.equal(release.identity, "v0.4.0-rc.45012e05d932");
  assert.equal(
    expectedArchiveBasename(release),
    "bpa-local-v0.4.0-rc.45012e05d932-macos-arm64.tar.gz"
  );
});

test("rejects legacy names and metadata drift", () => {
  const release = createReleaseMetadata({
    runtimeVersion: "0.4.0",
    gitCommit: commit,
    nodeVersion: "24.18.0",
    platform: "darwin",
    architecture: "arm64"
  });
  assert.throws(
    () =>
      assertArchiveBasename(
        "bpa-local-v0.4.0-macos-arm64.tar.gz",
        release
      ),
    /refusing legacy or mismatched archive/u
  );
  assert.throws(
    () => validateReleaseMetadata({ ...release, nodeVersion: "24.18" }),
    /Node\.js version is invalid/u
  );
  assert.throws(
    () => validateReleaseMetadata({ ...release, identity: "v0.4.0-rc.bad" }),
    /Release identity/u
  );
});

test("detects sensitive values from file content without logging values", () => {
  const findings = sensitiveContentFindings(
    [
      "client_secret='abcdefghijklmnopqrstuvwxyz123456'",
      "-----BEGIN PRIVATE KEY-----",
      "AKIAABCDEFGHIJKLMNOP"
    ].join("\n"),
    "payload.txt"
  );
  assert.deepEqual(
    findings.map((finding) => finding.code).sort(),
    ["AWS_ACCESS_KEY", "LITERAL_SECRET_ASSIGNMENT", "PRIVATE_KEY"]
  );
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes("abc")));
  assert.deepEqual(
    sensitiveContentFindings(
      "public_key_spki_base64='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'",
      "manifest.json"
    ),
    []
  );
});

test("recursively scans release files and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "bpa-release-gates-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "safe.txt"), "safe release content");
    assert.deepEqual(await scanReleaseTree(root), []);
    await writeFile(
      join(root, "nested", "secret.txt"),
      "password='abcdefghijklmnopqrstuvwxyz123456'"
    );
    assert.deepEqual(await scanReleaseTree(root), [
      {
        code: "LITERAL_SECRET_ASSIGNMENT",
        path: "nested/secret.txt"
      }
    ]);
    await symlink("safe.txt", join(root, "nested", "linked.txt"));
    await assert.rejects(
      scanReleaseTree(root),
      /regular files only/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
