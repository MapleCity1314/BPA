import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
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
  assert.equal(release.identity, "v0.4.0-rc.45012e05d932.node24.18.0");
  assert.equal(
    expectedArchiveBasename(release),
    "bpa-local-v0.4.0-rc.45012e05d932.node24.18.0-macos-arm64.tar.gz"
  );
});

test("derives a Windows x64 archive from the same immutable inputs", () => {
  const release = createReleaseMetadata({
    runtimeVersion: "0.4.0",
    gitCommit: commit,
    nodeVersion: "24.14.0",
    platform: "win32",
    architecture: "x64"
  });
  assert.deepEqual(validateReleaseMetadata(release), release);
  assert.equal(
    expectedArchiveBasename(release),
    "bpa-local-v0.4.0-rc.45012e05d932.node24.14.0-windows-x64.zip"
  );
});

test("uses the exact Node.js patch in the immutable RC identity", () => {
  const first = createReleaseMetadata({
    runtimeVersion: "0.4.0",
    gitCommit: commit,
    nodeVersion: "24.14.0",
    platform: "win32",
    architecture: "x64"
  });
  const second = createReleaseMetadata({
    runtimeVersion: "0.4.0",
    gitCommit: commit,
    nodeVersion: "24.18.0",
    platform: "win32",
    architecture: "x64"
  });
  assert.notEqual(first.identity, second.identity);
});

test("uses build-directory-independent SEA configuration", async () => {
  const [powerShellSource, shellSource] = await Promise.all(
    ["package-windows-x64.ps1", "package-windows-x64.sh"].map((name) =>
      readFile(new URL(name, import.meta.url), "utf8")
    )
  );
  assert.match(powerShellSource, /main\s*=\s*"bpa-native-host\.cjs"/u);
  assert.match(powerShellSource, /output\s*=\s*"sea-prep\.blob"/u);
  assert.doesNotMatch(powerShellSource, /main\s*=\s*\$SeaBundle/u);
  assert.match(powerShellSource, /Push-Location \$SeaRoot/u);
  assert.match(
    shellSource,
    /"\$SEA_ROOT\/sea-config\.json"\s*\\\s*"bpa-native-host\.cjs"\s*\\\s*"sea-prep\.blob"/u
  );
  assert.match(shellSource, /cd "\$SEA_ROOT"/u);
  assert.doesNotMatch(
    shellSource,
    /--experimental-sea-config "\$SEA_ROOT\/sea-config\.json"/u
  );
});

test("allows CI to reuse only the successful Windows repository gate", async () => {
  const [powerShellSource, ciSource] = await Promise.all([
    readFile(new URL("package-windows-x64.ps1", import.meta.url), "utf8"),
    readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    )
  ]);
  assert.match(
    powerShellSource,
    /if \(-not \$SkipRepositoryVerification\) \{\s+pnpm verify/u
  );
  assert.match(
    powerShellSource,
    /\} else \{[\s\S]*?pnpm build[\s\S]*?Repository build failed\./u
  );
  assert.match(
    ciSource,
    /release-package-windows:\s+needs: verify-windows/u
  );
  assert.match(ciSource, /-SkipRepositoryVerification/u);
});

test("keeps WorkBuddy Windows installation progress machine-readable", async () => {
  const [
    runtimeInstaller,
    workBuddyInstaller,
    runtimeRollback,
    localCoreMain
  ] = await Promise.all([
    readFile(new URL("install-windows-x64.ps1", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../skills/doudian-alliance-retired-monitor/scripts/" +
          "Install-DoudianAllianceMonitor.ps1",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("rollback-windows.ps1", import.meta.url), "utf8"),
    readFile(
      new URL("../apps/local-core/src/main.ts", import.meta.url),
      "utf8"
    )
  ]);
  for (const installer of [runtimeInstaller, workBuddyInstaller]) {
    assert.match(
      installer,
      /\$ProgressPreference\s*=\s*"SilentlyContinue"/u
    );
  }
  assert.match(
    workBuddyInstaller,
    /\$RuntimeInstallerOutput\s*=\s*@\([\s\S]*?\*>&1[\s\S]*?\)/u
  );
  assert.match(workBuddyInstaller, /\[string\]\$ResultPath/u);
  assert.match(
    workBuddyInstaller,
    /\$TemporaryResult[\s\S]*?Move-Item[\s\S]*?\$ResolvedResultPath/u
  );
  assert.match(workBuddyInstaller, /workbuddy-install\.log/u);
  assert.match(workBuddyInstaller, /function Get-OptionalProperty/u);
  assert.match(workBuddyInstaller, /function ConvertFrom-JsonItems/u);
  assert.match(
    workBuddyInstaller,
    /Get-OptionalProperty \$_ "disconnectedAt"/u
  );
  assert.match(runtimeInstaller, /runtime-install\.log/u);
  assert.match(workBuddyInstaller, /"--input-file", \$InputFile/u);
  assert.doesNotMatch(
    workBuddyInstaller,
    /"--input", "\{`"maxShops/u
  );
  for (const installer of [
    runtimeInstaller,
    workBuddyInstaller,
    runtimeRollback
  ]) {
    assert.doesNotMatch(
      installer,
      /(?:\bnode(?:\.exe)?["']?|node\\node\.exe["')\s]*)[\s\S]{0,80}(?:\s-e\b|--eval\b|--input-type=module)/iu
    );
  }
  assert.match(workBuddyInstaller, /\.deployment-/u);
  assert.match(
    workBuddyInstaller,
    /-ConfigurationPath \$ConfigurationPath/u
  );
  assert.match(
    workBuddyInstaller,
    /if \(-not \$SmokeSucceeded\)[\s\S]*?exit 0[\s\S]*?\$DeploymentFiles/u
  );
  assert.match(
    workBuddyInstaller,
    /Test-Path -LiteralPath \$Smoke\.record\.dailyPath -PathType Leaf/u
  );
  assert.match(
    workBuddyInstaller,
    /\$PersistedAttempts = @\(\$PersistedSmoke\.attempts\)/u
  );
  assert.match(
    workBuddyInstaller,
    /\$ScannedShopCount -ne \$DiscoveredShopCount/u
  );
  assert.match(workBuddyInstaller, /\$FailedShopCount -ne 0/u);
  assert.match(workBuddyInstaller, /LIVE_ACCEPTANCE_RECORD_INVALID/u);
  assert.match(workBuddyInstaller, /recordVerified = \$true/u);
  assert.match(
    workBuddyInstaller,
    /workflow = "doudian\.alliance-retired-products-monitor@3\.0\.9"/u
  );
  assert.match(workBuddyInstaller, /"--version", "3\.0\.9"/u);
  assert.match(
    workBuddyInstaller,
    /foreach \(\$Asset in \$RequiredAssets\)[\s\S]*?"validate"[\s\S]*?\}\s*foreach \(\$Asset in \$RequiredAssets\)[\s\S]*?"publish"/u
  );
  const assetLoops = [...workBuddyInstaller.matchAll(
    /foreach \(\$Asset in \$RequiredAssets\) \{([\s\S]*?)\r?\n\}/gu
  )].map((match) => match[1] ?? "");
  assert.ok(assetLoops.length >= 3);
  const validationLoop = assetLoops.find((loop) => loop.includes('"validate"'));
  const publicationLoop = assetLoops.find((loop) => loop.includes('"publish"'));
  assert.ok(validationLoop);
  assert.ok(publicationLoop);
  assert.doesNotMatch(validationLoop, /"publish"/u);
  assert.doesNotMatch(publicationLoop, /"validate"/u);
  assert.match(
    localCoreMain,
    /process\.stdout\.write\("BPA migrations completed successfully/u
  );
  assert.doesNotMatch(
    localCoreMain,
    /process\.stderr\.write\("BPA migrations completed successfully/u
  );
});

test("retries transient Windows package verification cleanup", async () => {
  const verifier = await readFile(
    new URL("verify-package-windows-x64.ps1", import.meta.url),
    "utf8"
  );
  assert.match(verifier, /function Remove-VerificationStage/u);
  assert.match(verifier, /\$Attempt -le 20/u);
  assert.match(verifier, /Start-Sleep -Milliseconds 250/u);
  assert.match(verifier, /Remove-VerificationStage -Path \$Stage/u);
});

test("bounds fresh Windows Runtime copy retries to sharing violations", async () => {
  const [installer, runtimeCommon, behaviorTest] = await Promise.all([
    readFile(new URL("install-windows-x64.ps1", import.meta.url), "utf8"),
    readFile(new URL("windows-runtime-common.ps1", import.meta.url), "utf8"),
    readFile(
      new URL("windows-runtime-copy-retry.test.ps1", import.meta.url),
      "utf8"
    )
  ]);
  assert.match(
    runtimeCommon,
    /function Test-BpaTransientFileSharingViolation\([\s\S]*?\$NativeCode -eq 32 -or \$NativeCode -eq 33/u
  );
  assert.match(
    installer,
    /\$InstallId = \[Guid\]::NewGuid\(\)\.ToString\("N"\)[\s\S]*?\$StagingRoot = Join-Path \$InstallRoot "\.install\.\$InstallId"/u
  );
  assert.match(
    runtimeCommon,
    /function Assert-BpaFreshInstallStagingPath[\s\S]*?\^\\\.install\\\.\[a-f0-9\]\{32\}\$/u
  );
  assert.match(
    runtimeCommon,
    /function Remove-BpaFreshInstallStaging[\s\S]*?\[int\]\$MaximumAttempts = 5/u
  );
  assert.match(
    runtimeCommon,
    /function Copy-BpaPackagedRuntimeForFreshInstall[\s\S]*?\[int\]\$MaximumAttempts = 4[\s\S]*?\[int\]\$CleanupMaximumAttempts = 5/u
  );
  assert.match(
    runtimeCommon,
    /\$Retryable = Test-BpaTransientFileSharingViolation \$_\.Exception[\s\S]*?Remove-BpaFreshInstallStaging[\s\S]*?if \(-not \$Retryable -or \$Attempt -eq \$MaximumAttempts\)[\s\S]*?throw \$CopyFailure/u
  );
  assert.match(
    runtimeCommon,
    /\[System\.AggregateException\]::new\([\s\S]*?\$CopyFailure\.Exception,[\s\S]*?\$CleanupFailure\.Exception/u
  );
  assert.match(
    installer,
    /Write-RuntimeInstallTrace "fresh-install-copy-started" \$Version\s+Copy-BpaPackagedRuntimeForFreshInstall[\s\S]*?-OnRetry \{[\s\S]*?"fresh-install-copy-retry"[\s\S]*?Copy-Item\s+`\s+-LiteralPath \(Join-Path \$StagingRoot "extension"\)/u
  );
  assert.doesNotMatch(installer, /function Copy-BpaPackagedRuntimeForFreshInstall/u);
  for (const expected of [
    "-2147024864",
    "-2147024863",
    "-2147024891",
    "-MaximumAttempts 3",
    ".install.not-a-guid",
    "[System.AggregateException]"
  ]) {
    assert.ok(
      behaviorTest.includes(expected),
      `Windows Runtime copy behavior test is missing ${expected}`
    );
  }
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
