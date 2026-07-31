[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA"),
  [switch]$PurgeData
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

$RunRegistry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$NativeHostRegistry =
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bpa.browser"
$CurrentPointer = Join-Path $InstallRoot "runtime\current.txt"
$ExpectedIdentity = $null
if (Test-Path -LiteralPath $CurrentPointer -PathType Leaf) {
  $ExpectedIdentity = Get-BpaRuntimeIdentity -PointerPath $CurrentPointer
}
Stop-BpaCoreSafely `
  -InstallRoot $InstallRoot `
  -ExpectedRuntimeIdentity $ExpectedIdentity
Remove-ItemProperty `
  -Path $RunRegistry `
  -Name "BPA Core" `
  -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $NativeHostRegistry -Recurse -ErrorAction SilentlyContinue
if (
  [Environment]::GetEnvironmentVariable("BPA_HOME", "User") -eq $InstallRoot
) {
  [Environment]::SetEnvironmentVariable("BPA_HOME", $null, "User")
}

foreach ($Relative in @("bin", "extension", "native-host", "runtime", "run")) {
  $Target = Join-Path $InstallRoot $Relative
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
  }
}
if ($PurgeData) {
  foreach ($Relative in @("data", "backups", "logs")) {
    $Target = Join-Path $InstallRoot $Relative
    if (Test-Path -LiteralPath $Target) {
      Remove-Item -LiteralPath $Target -Recurse -Force
    }
  }
}
if ($PurgeData) {
  Write-Host "BPA runtime and business data were removed."
} else {
  Write-Host "BPA runtime was removed; business data and backups were preserved."
}
