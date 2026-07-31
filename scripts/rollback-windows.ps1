[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RuntimeRoot = Join-Path $InstallRoot "runtime"
$CurrentPointer = Join-Path $RuntimeRoot "current.txt"
$PreviousPointer = Join-Path $RuntimeRoot "previous.txt"
if (-not (Test-Path -LiteralPath $PreviousPointer -PathType Leaf)) {
  throw "No previous BPA Windows runtime is recorded."
}
$Previous = (Get-Content -LiteralPath $PreviousPointer -Raw).Trim()
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot $Previous))) {
  throw "Recorded previous runtime is unavailable: $Previous"
}
$Current = (Get-Content -LiteralPath $CurrentPointer -Raw).Trim()
[IO.File]::WriteAllText(
  "$CurrentPointer.next",
  "$Previous`r`n",
  [Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath "$CurrentPointer.next" -Destination $CurrentPointer -Force
[IO.File]::WriteAllText(
  $PreviousPointer,
  "$Current`r`n",
  [Text.UTF8Encoding]::new($false)
)
$NativeHostRegistry =
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bpa.browser"
$NativeHostManifest = Join-Path $InstallRoot "native-host\com.bpa.browser.json"
$ExtensionId = "hoobbnlkcdhbemedpfhhoicklplggmbc"
$NativeHost = @{
  name = "com.bpa.browser"
  description = "BPA local browser bridge"
  path = (Join-Path $RuntimeRoot "$Previous\bin\bpa-native-host.exe")
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
Write-Host "BPA runtime pointer changed to $Previous."
Write-Host "Database rollback is intentionally not automatic."
