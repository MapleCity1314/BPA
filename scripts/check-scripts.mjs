import { readdir, readFile } from "node:fs/promises";
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
  "BPA Core exited before creating its identity lock",
  "[int]$Attempts = 3"
]) {
  if (!runtimeCommon.includes(required)) {
    throw new Error(`Windows process identity gate is missing ${required}`);
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

process.stdout.write(
  `Verified ${shellScripts.length} shell and ${powerShellScripts.length} PowerShell scripts.\n`
);
