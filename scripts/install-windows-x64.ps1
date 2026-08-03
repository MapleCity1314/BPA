[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA"),
  [string]$TracePath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($TracePath)) {
  $TracePath = Join-Path $InstallRoot "logs\runtime-install.log"
}

function Write-RuntimeInstallTrace([string]$Stage, [string]$Detail = "") {
  $TraceDirectory = Split-Path -Parent $script:TracePath
  New-Item -ItemType Directory -Path $TraceDirectory -Force | Out-Null
  $Line = "{0}`t{1}`t{2}`r`n" -f `
    (Get-Date).ToUniversalTime().ToString("o"), `
    $Stage, `
    $Detail.Replace("`r", " ").Replace("`n", " ")
  [IO.File]::AppendAllText(
    $script:TracePath,
    $Line,
    [Text.UTF8Encoding]::new($false)
  )
}

Write-RuntimeInstallTrace "started"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeHelpers = Join-Path $ScriptRoot "runtime-common.ps1"
if (-not (Test-Path -LiteralPath $RuntimeHelpers -PathType Leaf)) {
  $RuntimeHelpers = Join-Path $ScriptRoot "windows-runtime-common.ps1"
}
if (-not (Test-Path -LiteralPath $RuntimeHelpers -PathType Leaf)) {
  throw "BPA Windows runtime helpers are missing."
}
. $RuntimeHelpers

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
Write-RuntimeInstallTrace "packaged-closure-verified"

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw |
  ConvertFrom-Json
if ($Manifest.platform -ne "win32" -or $Manifest.architecture -ne "x64") {
  throw "This package is not a Windows x64 BPA runtime."
}
if ([string]$Manifest.nodeVersion -ne "24.18.0") {
  throw "BPA requires the pinned bundled Node.js 24.18.0 runtime."
}
$Version = [string]$Manifest.release.identity
if (
  $Version -notmatch
    "^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[a-f0-9]{12}\.node24\.[0-9]+\.[0-9]+$"
) {
  throw "Runtime identity is invalid."
}
$VersionRoot = Join-Path $RuntimeRoot $Version

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

$InstallLockPath = Join-Path $RunRoot "runtime-install.lock"
$RuntimeMaintenancePath = Join-Path $RunRoot "runtime-maintenance.lock"
try {
  $InstallLockStream = [IO.File]::Open(
    $InstallLockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch {
  throw "BPA_INSTALL_ALREADY_RUNNING"
}
[IO.File]::WriteAllText(
  $RuntimeMaintenancePath,
  "$PID`r`n",
  [Text.UTF8Encoding]::new($false)
)

$InstallId = [Guid]::NewGuid().ToString("N")
$StagingRoot = Join-Path $InstallRoot ".install.$InstallId"
$MigrationRoot = Join-Path $InstallRoot ".migration-test.$InstallId"
$ExtensionStage = Join-Path $InstallRoot ".extension.install.$InstallId"
$ExtensionBackup = Join-Path $InstallRoot ".extension.rollback.$Version.$InstallId"
$DatabaseBackup = $null
$OldCurrent = $null
$OldPrevious = $null
$RuntimeSwitched = $false
$RuntimeFilesSwitched = $false
$ExtensionSwitched = $false
$RuntimeVersionBackup = Join-Path $InstallRoot ".runtime.rollback.$InstallId"
$NativeHostBackup = Join-Path $InstallRoot ".native-host.rollback.$InstallId.json"
$HadNativeHostManifest = Test-Path -LiteralPath $NativeHostManifest -PathType Leaf
$OldNativeHostRegistry = $null
$HadNativeHostRegistry = Test-Path -LiteralPath $NativeHostRegistry
if ($HadNativeHostRegistry) {
  $OldNativeHostRegistry = (Get-Item -LiteralPath $NativeHostRegistry).GetValue("")
}
$OldBpaHome = [Environment]::GetEnvironmentVariable("BPA_HOME", "User")
$HadRunValue = $false
$OldRunValue = $null
if (Test-Path -LiteralPath $RunRegistry) {
  $RunProperty = Get-ItemProperty `
    -LiteralPath $RunRegistry `
    -Name "BPA Core" `
    -ErrorAction SilentlyContinue
  if ($RunProperty) {
    $HadRunValue = $true
    $OldRunValue = [string]$RunProperty."BPA Core"
  }
}
$PreviousPointer = Join-Path $RuntimeRoot "previous.txt"
if (Test-Path -LiteralPath $PreviousPointer -PathType Leaf) {
  $OldPrevious = Get-Content -LiteralPath $PreviousPointer -Raw
}
if ($HadNativeHostManifest) {
  Copy-Item -LiteralPath $NativeHostManifest -Destination $NativeHostBackup
}

function Set-CurrentRuntime([string]$Identity) {
  Set-BpaRuntimePointer -PointerPath $CurrentPointer -Identity $Identity
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
  $ExpectedIdentity = $null
  if (Test-Path -LiteralPath $CurrentPointer -PathType Leaf) {
    $ExpectedIdentity = Get-BpaRuntimeIdentity -PointerPath $CurrentPointer
  }
  Stop-BpaCoreSafely `
    -InstallRoot $InstallRoot `
    -ExpectedRuntimeIdentity $ExpectedIdentity
}

function Start-BpaCore {
  $Identity = (Get-Content -LiteralPath $CurrentPointer -Raw).Trim()
  Start-BpaCoreProcess `
    -InstallRoot $InstallRoot `
    -RuntimeIdentity $Identity
}

function Test-SqliteDatabase([string]$DatabasePath, [string]$RuntimePath) {
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    return
  }
  & (Join-Path $RuntimePath "node\node.exe") `
    (Join-Path $RuntimePath "bin\bpa-sqlite-tool.js") `
    "check" `
    $DatabasePath
  if ($LASTEXITCODE -ne 0) {
    throw "SQLite integrity check failed."
  }
}

function Backup-SqliteDatabase(
  [string]$DatabasePath,
  [string]$BackupPath,
  [string]$RuntimePath
) {
  & (Join-Path $RuntimePath "node\node.exe") `
    (Join-Path $RuntimePath "bin\bpa-sqlite-tool.js") `
    "backup" `
    $DatabasePath `
    $BackupPath
  if ($LASTEXITCODE -ne 0) {
    throw "SQLite consistent backup failed."
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
set "BPA_RUNTIME_ID=%BPA_RUNTIME_ID%"
"$RuntimeRoot\%BPA_RUNTIME_ID%\node\node.exe" "$RuntimeRoot\%BPA_RUNTIME_ID%\bin\$($Pair.Value)" %*
"@
    [IO.File]::WriteAllText(
      (Join-Path $BinRoot $Pair.Key),
      $Launcher,
      [Text.Encoding]::ASCII
    )
  }
}

function Install-HostIntegration {
  Write-Launchers
  Copy-Item `
    -LiteralPath (Join-Path $PackageRoot "rollback.ps1") `
    -Destination (Join-Path $BinRoot "bpa-rollback.ps1") `
    -Force
  Copy-Item `
    -LiteralPath $RuntimeHelpers `
    -Destination (Join-Path $BinRoot "runtime-common.ps1") `
    -Force

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
}

try {
  if (Test-Path -LiteralPath $CurrentPointer -PathType Leaf) {
    $OldCurrent = (Get-Content -LiteralPath $CurrentPointer -Raw).Trim()
  }
  $InstalledClosureHealthy = $false
  if ($OldCurrent -eq $Version -and (Test-Path -LiteralPath $VersionRoot)) {
    & (Join-Path $VersionRoot "node\node.exe") `
      (Join-Path $VersionRoot "bin\bpa-runtime-verify.js") `
      $VersionRoot
    $InstalledClosureHealthy = $LASTEXITCODE -eq 0
  }
  if ($InstalledClosureHealthy) {
    Write-RuntimeInstallTrace "same-version-repair-started" $Version
    Copy-Item `
      -LiteralPath (Join-Path $PackagedRuntime "extension") `
      -Destination $ExtensionStage `
      -Recurse
    if (Test-Path -LiteralPath $ExtensionRoot) {
      Move-Item -LiteralPath $ExtensionRoot -Destination $ExtensionBackup
    }
    Move-Item -LiteralPath $ExtensionStage -Destination $ExtensionRoot
    $ExtensionSwitched = $true
    Install-HostIntegration
    if (Test-Path -LiteralPath $RuntimeMaintenancePath) {
      Remove-Item -LiteralPath $RuntimeMaintenancePath -Force
    }
    try {
      Wait-BpaCoreHealthy `
        -InstallRoot $InstallRoot `
        -RuntimeIdentity $Version `
        -Attempts 1
    } catch {
      Stop-BpaCore
      Start-BpaCore
      Wait-BpaCoreHealthy `
        -InstallRoot $InstallRoot `
        -RuntimeIdentity $Version
    }
    Write-RuntimeInstallTrace "same-version-repair-completed" $Version
    if (Test-Path -LiteralPath $ExtensionBackup) {
      Remove-Item `
        -LiteralPath $ExtensionBackup `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
    $InstallLockStream.Dispose()
    Write-Host "BPA $Version repaired from a verified installed closure."
    Write-Host "CLI: $(Join-Path $BinRoot 'bpa.cmd')"
    Write-Host "Extension: $ExtensionRoot"
    return
  }
  Write-RuntimeInstallTrace "fresh-install-copy-started" $Version
  Copy-Item -LiteralPath $PackagedRuntime -Destination $StagingRoot -Recurse
  Copy-Item `
    -LiteralPath (Join-Path $StagingRoot "extension") `
    -Destination $ExtensionStage `
    -Recurse

  & (Join-Path $StagingRoot "node\node.exe") `
    (Join-Path $StagingRoot "bin\bpa-sqlite-tool.js") `
    "check-memory"
  if ($LASTEXITCODE -ne 0) {
    throw "The packaged SQLite native module could not be loaded."
  }
  if (Test-Path -LiteralPath $DataDb -PathType Leaf) {
    & (Join-Path $StagingRoot "node\node.exe") `
      (Join-Path $StagingRoot "bin\bpa-sqlite-tool.js") `
      "quiescent" `
      $DataDb
    if ($LASTEXITCODE -ne 0) {
      throw "BPA_RUNTIME_BUSY"
    }
  }

  Stop-BpaCore

  if (Test-Path -LiteralPath $DataDb -PathType Leaf) {
    Test-SqliteDatabase $DataDb $StagingRoot
    $Timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $DatabaseBackup = Join-Path $BackupRoot "bpa-before-$Version-$Timestamp-$InstallId.sqlite"
    Backup-SqliteDatabase $DataDb $DatabaseBackup $StagingRoot
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

  if (Test-Path -LiteralPath $VersionRoot) {
    Move-Item -LiteralPath $VersionRoot -Destination $RuntimeVersionBackup
  }
  Move-Item -LiteralPath $StagingRoot -Destination $VersionRoot
  $RuntimeFilesSwitched = $true
  if ($OldCurrent) {
    [IO.File]::WriteAllText(
      $PreviousPointer,
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
  Install-HostIntegration

  if (Test-Path -LiteralPath $RuntimeMaintenancePath) {
    Remove-Item -LiteralPath $RuntimeMaintenancePath -Force
  }
  Start-BpaCore
  Wait-BpaCoreHealthy `
    -InstallRoot $InstallRoot `
    -RuntimeIdentity $Version
  if (-not (Test-Path -LiteralPath (Join-Path $ExtensionRoot "manifest.json"))) {
    throw "BPA Extension installation is incomplete."
  }
  Write-RuntimeInstallTrace "fresh-install-completed" $Version

  if (Test-Path -LiteralPath $ExtensionBackup) {
    Remove-Item `
      -LiteralPath $ExtensionBackup `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $MigrationRoot) {
    Remove-Item `
      -LiteralPath $MigrationRoot `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $RuntimeVersionBackup) {
    Remove-Item `
      -LiteralPath $RuntimeVersionBackup `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $NativeHostBackup) {
    Remove-Item `
      -LiteralPath $NativeHostBackup `
      -Force `
      -ErrorAction SilentlyContinue
  }
  $InstallLockStream.Dispose()

  Write-Host "BPA $Version installed from a verified Windows x64 closure."
  Write-Host "CLI: $(Join-Path $BinRoot 'bpa.cmd')"
  Write-Host "Extension: $ExtensionRoot"
  if ($DatabaseBackup) {
    Write-Host "Pre-upgrade database backup: $DatabaseBackup"
  }
} catch {
  $InstallError = $_
  Write-RuntimeInstallTrace "failed" $InstallError.Exception.Message
  $RollbackErrors = [System.Collections.Generic.List[string]]::new()
  try {
    Stop-BpaCore
  } catch {
    $RollbackErrors.Add("stop-core: $($_.Exception.Message)")
  }
  try {
    if ($ExtensionSwitched) {
      if (Test-Path -LiteralPath $ExtensionRoot) {
        Remove-Item -LiteralPath $ExtensionRoot -Recurse -Force
      }
      if (Test-Path -LiteralPath $ExtensionBackup) {
        Move-Item -LiteralPath $ExtensionBackup -Destination $ExtensionRoot
      }
    }
  } catch {
    $RollbackErrors.Add("extension: $($_.Exception.Message)")
  }
  try {
    if ($RuntimeSwitched) {
      if ($OldCurrent) {
        Set-CurrentRuntime $OldCurrent
      } elseif (Test-Path -LiteralPath $CurrentPointer) {
        Remove-Item -LiteralPath $CurrentPointer -Force
      }
    }
    if ($RuntimeFilesSwitched -and (Test-Path -LiteralPath $VersionRoot)) {
      Remove-Item -LiteralPath $VersionRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $RuntimeVersionBackup) {
      Move-Item -LiteralPath $RuntimeVersionBackup -Destination $VersionRoot
    }
    if ($OldPrevious -ne $null) {
      [IO.File]::WriteAllText(
        $PreviousPointer,
        $OldPrevious,
        [Text.UTF8Encoding]::new($false)
      )
    } elseif (Test-Path -LiteralPath $PreviousPointer) {
      Remove-Item -LiteralPath $PreviousPointer -Force
    }
  } catch {
    $RollbackErrors.Add("runtime: $($_.Exception.Message)")
  }
  try {
    if ($DatabaseBackup -and (Test-Path -LiteralPath $DatabaseBackup)) {
      foreach ($DatabaseFile in @($DataDb, "$DataDb-wal", "$DataDb-shm")) {
        if (Test-Path -LiteralPath $DatabaseFile) {
          Remove-Item -LiteralPath $DatabaseFile -Force
        }
      }
      Copy-Item -LiteralPath $DatabaseBackup -Destination $DataDb -Force
    }
  } catch {
    $RollbackErrors.Add("database: $($_.Exception.Message)")
  }
  try {
    if ($HadNativeHostManifest -and (Test-Path -LiteralPath $NativeHostBackup)) {
      Copy-Item -LiteralPath $NativeHostBackup -Destination $NativeHostManifest -Force
    } elseif (Test-Path -LiteralPath $NativeHostManifest) {
      Remove-Item -LiteralPath $NativeHostManifest -Force
    }
    if ($HadNativeHostRegistry) {
      New-Item -Path $NativeHostRegistry -Force | Out-Null
      Set-Item -Path $NativeHostRegistry -Value $OldNativeHostRegistry
    } elseif (Test-Path -LiteralPath $NativeHostRegistry) {
      Remove-Item -LiteralPath $NativeHostRegistry -Recurse -Force
    }
  } catch {
    $RollbackErrors.Add("native-host: $($_.Exception.Message)")
  }
  try {
    [Environment]::SetEnvironmentVariable("BPA_HOME", $OldBpaHome, "User")
    if ($HadRunValue) {
      New-ItemProperty `
        -Path $RunRegistry `
        -Name "BPA Core" `
        -Value $OldRunValue `
        -PropertyType String `
        -Force | Out-Null
    } else {
      Remove-ItemProperty `
        -Path $RunRegistry `
        -Name "BPA Core" `
        -ErrorAction SilentlyContinue
    }
  } catch {
    $RollbackErrors.Add("environment: $($_.Exception.Message)")
  }
  try {
    foreach ($Temporary in @($StagingRoot, $MigrationRoot, $ExtensionStage)) {
      if (Test-Path -LiteralPath $Temporary) {
        Remove-Item -LiteralPath $Temporary -Recurse -Force
      }
    }
  } catch {
    $RollbackErrors.Add("cleanup: $($_.Exception.Message)")
  }
  try {
    if ($OldCurrent) {
      if (Test-Path -LiteralPath $RuntimeMaintenancePath) {
        Remove-Item -LiteralPath $RuntimeMaintenancePath -Force
      }
      Start-BpaCore
    }
  } catch {
    $RollbackErrors.Add("restart-old-core: $($_.Exception.Message)")
  } finally {
    if (Test-Path -LiteralPath $RuntimeMaintenancePath) {
      Remove-Item `
        -LiteralPath $RuntimeMaintenancePath `
        -Force `
        -ErrorAction SilentlyContinue
    }
    $InstallLockStream.Dispose()
  }
  if ($RollbackErrors.Count -gt 0) {
    throw (
      "BPA_INSTALL_FAILED_ROLLBACK_INCOMPLETE: " +
      $InstallError.Exception.Message +
      "; rollback=" +
      ($RollbackErrors -join " | ")
    )
  }
  throw $InstallError
}
