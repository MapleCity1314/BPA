[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RuntimeHelpers = Join-Path `
  (Split-Path -Parent $MyInvocation.MyCommand.Path) `
  "runtime-common.ps1"
if (-not (Test-Path -LiteralPath $RuntimeHelpers -PathType Leaf)) {
  throw "BPA Windows runtime helpers are missing."
}
. $RuntimeHelpers

$RuntimeRoot = Join-Path $InstallRoot "runtime"
$CurrentPointer = Join-Path $RuntimeRoot "current.txt"
$PreviousPointer = Join-Path $RuntimeRoot "previous.txt"
$DataDb = Join-Path $InstallRoot "data\bpa.sqlite"
$ExtensionRoot = Join-Path $InstallRoot "extension"
$NativeHostManifest = Join-Path `
  $InstallRoot `
  "native-host\com.bpa.browser.json"
$NativeHostRegistry =
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bpa.browser"
$ExtensionId = "hoobbnlkcdhbemedpfhhoicklplggmbc"

$Current = Get-BpaRuntimeIdentity -PointerPath $CurrentPointer
$Previous = Get-BpaRuntimeIdentity -PointerPath $PreviousPointer
if ($Current -eq $Previous) {
  throw "Current and previous BPA runtimes must be different."
}
$TargetRoot = Join-Path $RuntimeRoot $Previous
$TargetManifestPath = Join-Path $TargetRoot "runtime-manifest.json"
$TargetExtension = Join-Path $TargetRoot "extension"
foreach ($Required in @(
  (Join-Path $TargetRoot "node\node.exe"),
  (Join-Path $TargetRoot "bin\bpa-core.js"),
  (Join-Path $TargetRoot "bin\bpa.js"),
  $TargetManifestPath,
  (Join-Path $TargetExtension "manifest.json")
)) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
    throw "Previous BPA runtime is incomplete: $Required"
  }
}

& (Join-Path $TargetRoot "node\node.exe") `
  (Join-Path $TargetRoot "bin\bpa-runtime-verify.js") `
  $TargetRoot
if ($LASTEXITCODE -ne 0) {
  throw "Previous BPA runtime closure verification failed."
}
$TargetManifest = Get-Content -LiteralPath $TargetManifestPath -Raw |
  ConvertFrom-Json
if ([string]$TargetManifest.release.identity -ne $Previous) {
  throw "Previous pointer does not match the target Runtime Manifest."
}
$TargetSchema = [int]$TargetManifest.databaseSchemaVersion
$LiveSchema = 0
if (Test-Path -LiteralPath $DataDb -PathType Leaf) {
  Push-Location $TargetRoot
  try {
    $LiveSchemaText = & (Join-Path $TargetRoot "node\node.exe") `
      --input-type=module `
      -e @'
import Database from "better-sqlite3";
const database = new Database(process.argv[1], { readonly: true });
const table = database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
).get();
const row = table
  ? database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
    ).get()
  : { version: 0 };
database.close();
process.stdout.write(String(row.version));
'@ `
      $DataDb
    if ($LASTEXITCODE -ne 0) {
      throw "Live BPA database Schema could not be inspected safely."
    }
    $LiveSchema = [int]$LiveSchemaText
  } finally {
    Pop-Location
  }
}
if ($TargetSchema -lt $LiveSchema) {
  throw (
    "Rollback refused: runtime $Previous supports database Schema " +
    "$TargetSchema, but live data is Schema $LiveSchema. " +
    "Restore a pre-upgrade backup only after confirming no newer writes exist."
  )
}

function Set-BpaNativeHostRuntime([string]$Identity) {
  $HostExecutable = Join-Path `
    $RuntimeRoot `
    "$Identity\bin\bpa-native-host.exe"
  if (-not (Test-Path -LiteralPath $HostExecutable -PathType Leaf)) {
    throw "Native Host is missing from runtime $Identity."
  }
  $NativeHost = @{
    name = "com.bpa.browser"
    description = "BPA local browser bridge"
    path = $HostExecutable
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
}

$OperationId = [Guid]::NewGuid().ToString("N")
$ExtensionStage = Join-Path $InstallRoot ".extension.rollback.$OperationId"
$ExtensionBackup = Join-Path $InstallRoot ".extension.before-rollback.$OperationId"
$RuntimeSwitched = $false
$ExtensionSwitched = $false
$CoreStopped = $false

try {
  Copy-Item -LiteralPath $TargetExtension -Destination $ExtensionStage -Recurse
  Stop-BpaCoreSafely `
    -InstallRoot $InstallRoot `
    -ExpectedRuntimeIdentity $Current
  $CoreStopped = $true

  Set-BpaRuntimePointer -PointerPath $CurrentPointer -Identity $Previous
  Set-BpaRuntimePointer -PointerPath $PreviousPointer -Identity $Current
  $RuntimeSwitched = $true

  if (Test-Path -LiteralPath $ExtensionRoot) {
    Move-Item -LiteralPath $ExtensionRoot -Destination $ExtensionBackup
  }
  $ExtensionSwitched = $true
  Move-Item -LiteralPath $ExtensionStage -Destination $ExtensionRoot
  Set-BpaNativeHostRuntime $Previous

  Start-BpaCoreProcess `
    -InstallRoot $InstallRoot `
    -RuntimeIdentity $Previous
  Wait-BpaCoreHealthy `
    -InstallRoot $InstallRoot `
    -RuntimeIdentity $Previous

  if (Test-Path -LiteralPath $ExtensionBackup) {
    Remove-Item -LiteralPath $ExtensionBackup -Recurse -Force
  }
  Write-Host "BPA rolled back to $Previous without changing business data."
  Write-Host "Reload BPA Browser Bridge in Chrome to activate the rolled-back extension."
} catch {
  $Failure = $_
  if ($RuntimeSwitched) {
    try {
      Stop-BpaCoreSafely `
        -InstallRoot $InstallRoot `
        -ExpectedRuntimeIdentity $Previous
    } catch {
      Write-Warning "The failed rollback Core could not be stopped automatically."
    }
  }
  if ($ExtensionSwitched) {
    if (Test-Path -LiteralPath $ExtensionRoot) {
      Remove-Item -LiteralPath $ExtensionRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $ExtensionBackup) {
      Move-Item -LiteralPath $ExtensionBackup -Destination $ExtensionRoot
    }
  }
  if ($RuntimeSwitched) {
    Set-BpaRuntimePointer -PointerPath $CurrentPointer -Identity $Current
    Set-BpaRuntimePointer -PointerPath $PreviousPointer -Identity $Previous
    Set-BpaNativeHostRuntime $Current
  }
  if ($CoreStopped) {
    Start-BpaCoreProcess `
      -InstallRoot $InstallRoot `
      -RuntimeIdentity $Current
    Wait-BpaCoreHealthy `
      -InstallRoot $InstallRoot `
      -RuntimeIdentity $Current
  }
  throw $Failure
} finally {
  if (Test-Path -LiteralPath $ExtensionStage) {
    Remove-Item -LiteralPath $ExtensionStage -Recurse -Force
  }
}
