[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Archive
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
  throw "Windows package archive is missing."
}
$Stage = Join-Path $env:TEMP "bpa-windows-verify-$([Guid]::NewGuid().ToString('N'))"
try {
  Expand-Archive -LiteralPath $Archive -DestinationPath $Stage
  $Root = Join-Path $Stage "bpa"
  foreach ($Relative in @(
    "install.ps1",
    "rollback.ps1",
    "uninstall.ps1",
    "runtime-common.ps1",
    "runtime\runtime-manifest.json",
    "runtime\node\node.exe",
    "runtime\bin\bpa-native-host.exe",
    "runtime\extension\manifest.json"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $Relative) -PathType Leaf)) {
      throw "Windows package is missing $Relative."
    }
  }
  $Runtime = Join-Path $Root "runtime"
  & (Join-Path $Runtime "node\node.exe") `
    (Join-Path $Runtime "bin\bpa-runtime-verify.js") `
    $Runtime
  if ($LASTEXITCODE -ne 0) {
    throw "Windows runtime closure is invalid."
  }
  & (Join-Path $Runtime "node\node.exe") `
    (Join-Path $Runtime "bin\bpa-release-scan.js") `
    $Root
  if ($LASTEXITCODE -ne 0) {
    throw "Windows release content scan failed."
  }
  Write-Host "Verified BPA Windows x64 production archive: $Archive"
} finally {
  if (Test-Path -LiteralPath $Stage) {
    Remove-Item -LiteralPath $Stage -Recurse -Force
  }
}
