[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA"),
  [switch]$PurgeData
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RunRegistry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$NativeHostRegistry =
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bpa.browser"
$LockPath = Join-Path $InstallRoot "run\core.lock"

if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
  $OwnerPid = 0
  if (
    [int]::TryParse(
      (Get-Content -LiteralPath $LockPath -Raw).Trim(),
      [ref]$OwnerPid
    ) -and
    $OwnerPid -gt 0
  ) {
    Stop-Process -Id $OwnerPid -Force -ErrorAction SilentlyContinue
  }
}
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
