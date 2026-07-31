import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scriptsRoot = join(root, "scripts");
const files = await readdir(scriptsRoot);
const shellScripts = files
  .filter((name) => name.endsWith(".sh"))
  .map((name) => join(scriptsRoot, name));
const powerShellScripts = files
  .filter((name) => name.endsWith(".ps1"))
  .map((name) => join(scriptsRoot, name));

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
}

process.stdout.write(
  `Verified ${shellScripts.length} shell and ${powerShellScripts.length} PowerShell scripts.\n`
);
