import { access, readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scriptsRoot = join(root, "scripts");
const skillsRoot = join(root, "skills");
const files = await readdir(scriptsRoot);
const skillFiles = await readdir(skillsRoot, { recursive: true });
const shellScripts = files
  .filter((name) => name.endsWith(".sh"))
  .map((name) => join(scriptsRoot, name));
const powerShellScripts = files
  .filter((name) => name.endsWith(".ps1"))
  .map((name) => join(scriptsRoot, name))
  .concat(
    skillFiles
      .filter((name) => name.endsWith(".ps1"))
      .map((name) => join(skillsRoot, name))
  );

if (process.platform !== "win32") {
  const checked = spawnSync("zsh", ["-n", ...shellScripts], {
    cwd: root,
    encoding: "utf8"
  });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr || checked.stdout);
    process.exit(checked.status ?? 1);
  }
  const macosRuntimeGates = spawnSync(
    process.execPath,
    ["--test", join(scriptsRoot, "macos-runtime-install-gates.test.mjs")],
    { cwd: root, encoding: "utf8" }
  );
  if (macosRuntimeGates.status !== 0) {
    process.stderr.write(
      macosRuntimeGates.stderr || macosRuntimeGates.stdout
    );
    process.exit(macosRuntimeGates.status ?? 1);
  }
} else {
  for (const path of powerShellScripts) {
    const parsed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`
      ],
      { cwd: root, encoding: "utf8" }
    );
    if (parsed.status !== 0) {
      process.stderr.write(parsed.stderr || parsed.stdout);
      process.exit(parsed.status ?? 1);
    }
  }
  const behavior = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(scriptsRoot, "windows-runtime-copy-retry.test.ps1")
    ],
    { cwd: root, encoding: "utf8" }
  );
  if (behavior.status !== 0) {
    process.stderr.write(behavior.stderr || behavior.stdout);
    process.exit(behavior.status ?? 1);
  }
}

for (const path of powerShellScripts) {
  const source = await readFile(path, "utf8");
  if (
    !source.includes('$ErrorActionPreference = "Stop"') ||
    !source.includes("Set-StrictMode -Version Latest")
  ) {
    throw new Error(`PowerShell safety preamble is missing: ${path}`);
  }
  if (/Remove-Item\s+(?:-Recurse\s+)?-Force\s+["']?[A-Z]:\\?\s*$/imu.test(source)) {
    throw new Error(`PowerShell script contains a broad destructive target: ${path}`);
  }
  if (/Stop-Process[^\r\n]*-Force/iu.test(source)) {
    throw new Error(
      `PowerShell script must not force-stop an unverified process: ${path}`
    );
  }
}

const runtimeCommon = await readFile(
  join(scriptsRoot, "windows-runtime-common.ps1"),
  "utf8"
);
for (const required of [
  "Get-CimInstance",
  "Test-BpaPathEqual",
  "ExecutablePath",
  "CommandLine",
  "ExpectedRuntimeIdentity",
  "core.err.log",
  "bpa-core-launcher.js",
  "& $Node $Launcher *> $null",
  "BPA Core exited before creating its identity lock",
  "[int]$Attempts = 3"
]) {
  if (!runtimeCommon.includes(required)) {
    throw new Error(`Windows process identity gate is missing ${required}`);
  }
}
const windowsCoreLauncher = await readFile(
  join(scriptsRoot, "windows-core-launcher.mjs"),
  "utf8"
);
for (const required of [
  "attempt < 50",
  "lock.pid === child.pid",
  "lock.runtimeIdentity === runtimeIdentity",
  "normalizePath(lock.executablePath) === expectedExecutable",
  "normalizePath(lock.entryPointPath) === expectedEntryPoint",
  "child.kill()",
  "attempt < 20 && child.exitCode === null"
]) {
  if (!windowsCoreLauncher.includes(required)) {
    throw new Error(
      `Windows Core launcher readiness gate is missing ${required}`
    );
  }
}
for (const name of [
  "install-windows-x64.ps1",
  "rollback-windows.ps1",
  "uninstall-windows.ps1"
]) {
  const source = await readFile(join(scriptsRoot, name), "utf8");
  if (
    !source.includes("runtime-common.ps1") ||
    !source.includes("windows-runtime-common.ps1") ||
    !source.includes("Stop-BpaCoreSafely")
  ) {
    throw new Error(`${name} must use the shared safe Core lifecycle`);
  }
}
const windowsInstall = await readFile(
  join(scriptsRoot, "install-windows-x64.ps1"),
  "utf8"
);
for (const required of [
  "InstalledClosureHealthy",
  "bpa-runtime-verify.js",
  "repaired from a verified installed closure",
  "Install-HostIntegration"
]) {
  if (!windowsInstall.includes(required)) {
    throw new Error(`Windows same-version repair gate is missing ${required}`);
  }
}
const rollback = await readFile(
  join(scriptsRoot, "rollback-windows.ps1"),
  "utf8"
);
for (const required of [
  "databaseSchemaVersion",
  "Set-BpaRuntimePointer",
  "Wait-BpaCoreHealthy",
  "throw $Failure"
]) {
  if (!rollback.includes(required)) {
    throw new Error(`Windows rollback recovery gate is missing ${required}`);
  }
}

const [
  macosInstall,
  macosRollback,
  macosUninstall,
  closureBuilder,
  closureVerifier,
  macosGates,
  macosContract
] =
  await Promise.all([
    readFile(join(scriptsRoot, "install-macos-arm64.sh"), "utf8"),
    readFile(join(scriptsRoot, "rollback-macos.sh"), "utf8"),
    readFile(join(scriptsRoot, "uninstall-macos.sh"), "utf8"),
    readFile(join(scriptsRoot, "build-runtime-closure.mjs"), "utf8"),
    readFile(join(scriptsRoot, "verify-runtime-closure.mjs"), "utf8"),
    readFile(join(scriptsRoot, "macos-runtime-install-gates.mjs"), "utf8"),
    readFile(join(scriptsRoot, "macos-runtime-install-contract.mjs"), "utf8")
  ]);
if (macosInstall.includes('cat > "$STAGING_ROOT/bin/bpa-core"')) {
  throw new Error("macOS installer must not generate unverified runtime wrappers");
}
for (const required of [
  '"$PACKAGED_RUNTIME/bin/bpa-core-identity.js"',
  '"$VERSION_ROOT/bin/bpa-core-identity.js"',
  '--identity "$VERSION"',
  '--entrypoint "$VERSION_ROOT/bin/bpa-core.js"'
]) {
  if (!macosInstall.includes(required)) {
    throw new Error(`macOS Core process identity gate is missing ${required}`);
  }
}
for (const required of [
  "AGENT_BACKUP=",
  "HOST_MANIFEST_BACKUP=",
  "CHROME_AGENT_BACKUP=",
  "runtime-install.lock",
  "runtime-maintenance.lock",
  "runtime maintenance-status",
  "bpa-managed-chrome-agent.js",
  "chrome-write",
  "chrome-verify",
  'cp "$AGENT_BACKUP" "$LAUNCH_AGENT"',
  'cp "$HOST_MANIFEST_BACKUP" "$HOST_MANIFEST"',
  'cp "$CHROME_AGENT_BACKUP" "$CHROME_LAUNCH_AGENT"'
]) {
  if (!macosInstall.includes(required)) {
    throw new Error(`macOS first-cutover rollback is missing ${required}`);
  }
}
for (const required of [
  'export BPA_RUNTIME_ID="${release.identity}"',
  'VERSION_ROOT="\\${SCRIPT_ROOT:h}"',
  'CORE_ENV="\\$BPA_HOME/core.env"',
  "BPA Core configuration owner or permissions are invalid.",
  "renderManagedChromeLauncher(release.identity)",
  "MACOS_MANAGED_CHROME_CONTRACT",
  "await chmod(wrapperPath, 0o755)"
]) {
  if (!closureBuilder.includes(required)) {
    throw new Error(`macOS hashed Runtime wrapper is missing ${required}`);
  }
}
for (const required of [
  "requiredFiles.push(...manifestWrapperFiles)",
  "Runtime wrapper identity is invalid",
  "Managed Chrome launcher differs from the Runtime manifest"
]) {
  if (!closureVerifier.includes(required)) {
    throw new Error(`macOS wrapper verification is missing ${required}`);
  }
}
for (const required of [
  "assertRuntimeMaintenanceReadiness",
  "renderManagedChromeLaunchAgent",
  "assertManagedChromeProcessCommand",
  "--disable-extensions-except=$EXTENSION",
  "--load-extension=$EXTENSION",
  "chrome-inventory-profile",
  "127.0.0.1",
  "17660"
]) {
  if (!`${macosGates}\n${macosContract}`.includes(required)) {
    throw new Error(`Managed Chrome closure gate is missing ${required}`);
  }
}
for (const source of [macosInstall, macosRollback, macosUninstall]) {
  for (const required of [
    "runtime maintenance-status",
    "com.bpa.inventory-chrome",
    "bpa-managed-chrome-agent.js",
    "chrome-verify"
  ]) {
    if (!source.includes(required)) {
      throw new Error(`macOS lifecycle gate is missing ${required}`);
    }
  }
  if (
    source.includes("runtime-metrics") ||
    source.includes("runtime-resource-metrics")
  ) {
    throw new Error(
      "macOS lifecycle must not infer maintenance readiness from metrics files"
    );
  }
}
const installLockIndex = macosInstall.indexOf("INSTALL_LOCK_ACQUIRED=true");
const firstChromeTouchIndex = macosInstall.indexOf(
  "CHROME_LAUNCHD_TOUCHED=true"
);
const firstCoreTouchIndex = macosInstall.indexOf("CORE_LAUNCHD_TOUCHED=true");
if (
  installLockIndex < 0 ||
  firstChromeTouchIndex < installLockIndex ||
  firstCoreTouchIndex < installLockIndex
) {
  throw new Error("macOS installer must acquire its locks before launchd mutation");
}
const chromeSwitchIndex = macosInstall.indexOf("CHROME_AGENT_SWITCHED=true");
const chromeWriteIndex = macosInstall.indexOf("\n  chrome-write \\");
if (
  chromeSwitchIndex < 0 ||
  chromeWriteIndex < 0 ||
  chromeSwitchIndex > chromeWriteIndex
) {
  throw new Error(
    "macOS installer must arm Chrome rollback before replacing its Launch Agent"
  );
}
for (const required of [
  "CORE_LAUNCHD_TOUCHED=false",
  "CHROME_LAUNCHD_TOUCHED=false",
  "if $CHROME_LAUNCHD_TOUCHED",
  "if $CORE_LAUNCHD_TOUCHED"
]) {
  if (!macosInstall.includes(required)) {
    throw new Error(`macOS pre-lock launchd rollback guard is missing ${required}`);
  }
}
for (const required of [
  "REMOVAL_STARTED=false",
  "if ! $REMOVAL_STARTED",
  "if $CORE_STOPPED",
  "if $CHROME_STOPPED",
  "REMOVAL_STARTED=true"
]) {
  if (!macosUninstall.includes(required)) {
    throw new Error(`macOS uninstall pre-removal recovery is missing ${required}`);
  }
}
const obsoleteInventoryChromeAgent = join(
  root,
  "apps/inventory-monitor/deploy/com.bpa.inventory-chrome.plist"
);
try {
  await access(obsoleteInventoryChromeAgent);
  throw new Error(
    "Inventory Chrome Launch Agent must be owned by the Runtime closure"
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.stdout.write(
  `Verified ${shellScripts.length} shell and ${powerShellScripts.length} PowerShell scripts.\n`
);
