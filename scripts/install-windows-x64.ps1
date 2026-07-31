[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is required."
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "BPA requires 64-bit Windows."
}

$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackagedRuntime = Join-Path $PackageRoot "runtime"
$BundledNode = Join-Path $PackagedRuntime "node\node.exe"
$ManifestPath = Join-Path $PackagedRuntime "runtime-manifest.json"
$ExtensionId = "hoobbnlkcdhbemedpfhhoicklplggmbc"
$RuntimeRoot = Join-Path $InstallRoot "runtime"
$DataRoot = Join-Path $InstallRoot "data"
$DataDb = Join-Path $DataRoot "bpa.sqlite"
$BackupRoot = Join-Path $InstallRoot "backups"
$LogRoot = Join-Path $InstallRoot "logs"
$RunRoot = Join-Path $InstallRoot "run"
$BinRoot = Join-Path $InstallRoot "bin"
$ExtensionRoot = Join-Path $InstallRoot "extension"
$NativeHostRoot = Join-Path $InstallRoot "native-host"
$NativeHostManifest = Join-Path $NativeHostRoot "com.bpa.browser.json"
$CurrentPointer = Join-Path $RuntimeRoot "current.txt"
$RunRegistry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$NativeHostRegistry =
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bpa.browser"

if (-not (Test-Path -LiteralPath $BundledNode -PathType Leaf)) {
  throw "Packaged Node.js runtime is missing."
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Runtime manifest is missing."
}

& $BundledNode (Join-Path $PackagedRuntime "bin\bpa-runtime-verify.js") `
  $PackagedRuntime
if ($LASTEXITCODE -ne 0) {
  throw "Runtime closure verification failed."
}
& $BundledNode (Join-Path $PackagedRuntime "bin\bpa-release-scan.js") `
  $PackageRoot
if ($LASTEXITCODE -ne 0) {
  throw "Release content scan failed."
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw |
  ConvertFrom-Json
if ($Manifest.platform -ne "win32" -or $Manifest.architecture -ne "x64") {
  throw "This package is not a Windows x64 BPA runtime."
}
if (($Manifest.nodeVersion -split "\.")[0] -ne "24") {
  throw "BPA requires the bundled Node.js 24 runtime."
}
$Version = [string]$Manifest.release.identity
if ($Version -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[a-f0-9]{12}$") {
  throw "Runtime identity is invalid."
}
$VersionRoot = Join-Path $RuntimeRoot $Version
if (Test-Path -LiteralPath $VersionRoot) {
  throw "Runtime $Version is already installed and will not be overwritten."
}

$Directories = @(
  $InstallRoot,
  $RuntimeRoot,
  $DataRoot,
  $BackupRoot,
  $LogRoot,
  $RunRoot,
  $BinRoot,
  $NativeHostRoot
)
foreach ($Directory in $Directories) {
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
}

$InstallId = [Guid]::NewGuid().ToString("N")
$StagingRoot = Join-Path $InstallRoot ".install.$InstallId"
$MigrationRoot = Join-Path $InstallRoot ".migration-test.$InstallId"
$ExtensionStage = Join-Path $InstallRoot ".extension.install.$InstallId"
$ExtensionBackup = Join-Path $InstallRoot ".extension.rollback.$Version.$InstallId"
$DatabaseBackup = $null
$OldCurrent = $null
$RuntimeSwitched = $false
$ExtensionSwitched = $false

function Set-CurrentRuntime([string]$Identity) {
  $Next = "$CurrentPointer.next"
  [IO.File]::WriteAllText($Next, "$Identity`r`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $Next -Destination $CurrentPointer -Force
}

function Invoke-CurrentRuntime(
  [string]$EntryPoint,
  [string[]]$Arguments = @()
) {
  $Identity = (Get-Content -LiteralPath $CurrentPointer -Raw).Trim()
  $Root = Join-Path $RuntimeRoot $Identity
  $Node = Join-Path $Root "node\node.exe"
  $Script = Join-Path $Root "bin\$EntryPoint"
  & $Node $Script @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$EntryPoint exited with code $LASTEXITCODE."
  }
}

function Stop-BpaCore {
  $LockPath = Join-Path $RunRoot "core.lock"
  if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
    return
  }
  $OwnerText = (Get-Content -LiteralPath $LockPath -Raw).Trim()
  $OwnerPid = 0
  if ([int]::TryParse($OwnerText, [ref]$OwnerPid) -and $OwnerPid -gt 0) {
    $Process = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    if ($Process) {
      Stop-Process -Id $OwnerPid -Force
      $Process.WaitForExit(5000)
    }
  }
}

function Start-BpaCore {
  $Identity = (Get-Content -LiteralPath $CurrentPointer -Raw).Trim()
  $Root = Join-Path $RuntimeRoot $Identity
  $PreviousHome = $env:BPA_HOME
  try {
    $env:BPA_HOME = $InstallRoot
    Start-Process `
      -FilePath (Join-Path $Root "node\node.exe") `
      -ArgumentList @((Join-Path $Root "bin\bpa-core.js")) `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $LogRoot "core.stdout.log") `
      -RedirectStandardError (Join-Path $LogRoot "core.stderr.log")
  } finally {
    $env:BPA_HOME = $PreviousHome
  }
}

function Test-SqliteDatabase([string]$DatabasePath, [string]$RuntimePath) {
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    return
  }
  Push-Location $RuntimePath
  try {
    & (Join-Path $RuntimePath "node\node.exe") --input-type=module -e @'
import Database from "better-sqlite3";
const database = new Database(process.argv[1]);
database.pragma("wal_checkpoint(TRUNCATE)");
const rows = database.pragma("integrity_check");
database.close();
if (rows.length !== 1 || rows[0].integrity_check !== "ok") process.exit(1);
'@ $DatabasePath
    if ($LASTEXITCODE -ne 0) {
      throw "SQLite integrity check failed."
    }
  } finally {
    Pop-Location
  }
}

function Write-Launchers {
  $Entries = @{
    "bpa.cmd" = "bpa.js"
    "bpa-core.cmd" = "bpa-core.js"
    "bpa-native-host.cmd" = "bpa-native-host.js"
    "bpa-mcp.cmd" = "bpa-mcp.js"
  }
  foreach ($Pair in $Entries.GetEnumerator()) {
    $Launcher = @"
@echo off
setlocal
set "BPA_HOME=$InstallRoot"
set /p BPA_RUNTIME_ID=<"$CurrentPointer"
"$RuntimeRoot\%BPA_RUNTIME_ID%\node\node.exe" "$RuntimeRoot\%BPA_RUNTIME_ID%\bin\$($Pair.Value)" %*
"@
    [IO.File]::WriteAllText(
      (Join-Path $BinRoot $Pair.Key),
      $Launcher,
      [Text.Encoding]::ASCII
    )
  }
}

try {
  Stop-BpaCore
  Copy-Item -LiteralPath $PackagedRuntime -Destination $StagingRoot -Recurse
  Copy-Item `
    -LiteralPath (Join-Path $StagingRoot "extension") `
    -Destination $ExtensionStage `
    -Recurse

  Push-Location $StagingRoot
  try {
    & (Join-Path $StagingRoot "node\node.exe") -e `
      'import("better-sqlite3").then(({default: Database}) => new Database(":memory:").close())'
    if ($LASTEXITCODE -ne 0) {
      throw "The packaged SQLite native module could not be loaded."
    }
  } finally {
    Pop-Location
  }

  if (Test-Path -LiteralPath $DataDb -PathType Leaf) {
    Test-SqliteDatabase $DataDb $StagingRoot
    $Timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $DatabaseBackup = Join-Path $BackupRoot "bpa-before-$Version-$Timestamp.sqlite"
    Copy-Item -LiteralPath $DataDb -Destination $DatabaseBackup
    New-Item -ItemType Directory -Path (Join-Path $MigrationRoot "data") -Force |
      Out-Null
    Copy-Item `
      -LiteralPath $DatabaseBackup `
      -Destination (Join-Path $MigrationRoot "data\bpa.sqlite")
  }

  $PreviousHome = $env:BPA_HOME
  try {
    $env:BPA_HOME = $MigrationRoot
    & (Join-Path $StagingRoot "node\node.exe") `
      (Join-Path $StagingRoot "bin\bpa-core.js") --migrate-only
    if ($LASTEXITCODE -ne 0) {
      throw "Migration rehearsal failed."
    }
    Test-SqliteDatabase (Join-Path $MigrationRoot "data\bpa.sqlite") $StagingRoot

    $env:BPA_HOME = $InstallRoot
    & (Join-Path $StagingRoot "node\node.exe") `
      (Join-Path $StagingRoot "bin\bpa-core.js") --migrate-only
    if ($LASTEXITCODE -ne 0) {
      throw "Database migration failed."
    }
    Test-SqliteDatabase $DataDb $StagingRoot
  } finally {
    $env:BPA_HOME = $PreviousHome
  }

  Move-Item -LiteralPath $StagingRoot -Destination $VersionRoot
  if (Test-Path -LiteralPath $CurrentPointer -PathType Leaf) {
    $OldCurrent = (Get-Content -LiteralPath $CurrentPointer -Raw).Trim()
    [IO.File]::WriteAllText(
      (Join-Path $RuntimeRoot "previous.txt"),
      "$OldCurrent`r`n",
      [Text.UTF8Encoding]::new($false)
    )
  }
  Set-CurrentRuntime $Version
  $RuntimeSwitched = $true

  if (Test-Path -LiteralPath $ExtensionRoot) {
    Move-Item -LiteralPath $ExtensionRoot -Destination $ExtensionBackup
  }
  Move-Item -LiteralPath $ExtensionStage -Destination $ExtensionRoot
  $ExtensionSwitched = $true
  Write-Launchers

  $NativeHost = @{
    name = "com.bpa.browser"
    description = "BPA local browser bridge"
    path = (Join-Path $VersionRoot "bin\bpa-native-host.exe")
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
  } | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText(
    $NativeHostManifest,
    "$NativeHost`r`n",
    [Text.UTF8Encoding]::new($false)
  )
  New-Item -Path $NativeHostRegistry -Force | Out-Null
  Set-Item -Path $NativeHostRegistry -Value $NativeHostManifest
  [Environment]::SetEnvironmentVariable("BPA_HOME", $InstallRoot, "User")

  $StartupCommand =
    "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden " +
    "-Command `"& '$BinRoot\bpa-core.cmd'`""
  New-Item -Path $RunRegistry -Force | Out-Null
  New-ItemProperty `
    -Path $RunRegistry `
    -Name "BPA Core" `
    -Value $StartupCommand `
    -PropertyType String `
    -Force | Out-Null

  Start-BpaCore
  $Healthy = $false
  for ($Attempt = 0; $Attempt -lt 60; $Attempt += 1) {
    Start-Sleep -Milliseconds 250
    try {
      Invoke-CurrentRuntime "bpa.js" @("doctor") | Out-Null
      $Healthy = $true
      break
    } catch {
      continue
    }
  }
  if (-not $Healthy) {
    throw "BPA Core health check did not complete."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ExtensionRoot "manifest.json"))) {
    throw "BPA Extension installation is incomplete."
  }

  if (Test-Path -LiteralPath $ExtensionBackup) {
    Remove-Item -LiteralPath $ExtensionBackup -Recurse -Force
  }
  if (Test-Path -LiteralPath $MigrationRoot) {
    Remove-Item -LiteralPath $MigrationRoot -Recurse -Force
  }

  Write-Host "BPA $Version installed from a verified Windows x64 closure."
  Write-Host "CLI: $(Join-Path $BinRoot 'bpa.cmd')"
  Write-Host "Extension: $ExtensionRoot"
  if ($DatabaseBackup) {
    Write-Host "Pre-upgrade database backup: $DatabaseBackup"
  }
} catch {
  Stop-BpaCore
  if ($ExtensionSwitched) {
    if (Test-Path -LiteralPath $ExtensionRoot) {
      Remove-Item -LiteralPath $ExtensionRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $ExtensionBackup) {
      Move-Item -LiteralPath $ExtensionBackup -Destination $ExtensionRoot
    }
  }
  if ($RuntimeSwitched -and $OldCurrent) {
    Set-CurrentRuntime $OldCurrent
  }
  if ($DatabaseBackup -and (Test-Path -LiteralPath $DatabaseBackup)) {
    Copy-Item -LiteralPath $DatabaseBackup -Destination $DataDb -Force
  }
  foreach ($Temporary in @($StagingRoot, $MigrationRoot, $ExtensionStage)) {
    if (Test-Path -LiteralPath $Temporary) {
      Remove-Item -LiteralPath $Temporary -Recurse -Force
    }
  }
  if ($OldCurrent) {
    Start-BpaCore
  }
  throw
}
