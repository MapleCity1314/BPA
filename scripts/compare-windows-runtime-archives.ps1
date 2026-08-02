[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FirstArchive,
  [Parameter(Mandatory = $true)]
  [string]$SecondArchive
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

foreach ($Archive in @($FirstArchive, $SecondArchive)) {
  if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "Runtime archive is missing: $Archive"
  }
}

$ComparisonRoot = Join-Path ([IO.Path]::GetTempPath()) `
  "bpa-runtime-compare-$([Guid]::NewGuid().ToString('N'))"
$FirstRoot = Join-Path $ComparisonRoot "first"
$SecondRoot = Join-Path $ComparisonRoot "second"
New-Item -ItemType Directory -Path $FirstRoot, $SecondRoot -Force | Out-Null

function Get-FileManifest {
  param([string]$Root)
  $RuntimeRoot = Join-Path $Root "bpa\runtime"
  if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
    throw "Archive does not contain bpa/runtime: $Root"
  }
  $PrefixLength = $RuntimeRoot.Length + 1
  return @(
    Get-ChildItem -LiteralPath $RuntimeRoot -File -Recurse |
      ForEach-Object {
        [PSCustomObject]@{
          path = $_.FullName.Substring($PrefixLength).Replace("\", "/")
          size = $_.Length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
      } |
      Sort-Object path
  )
}

try {
  Expand-Archive -LiteralPath $FirstArchive -DestinationPath $FirstRoot
  Expand-Archive -LiteralPath $SecondArchive -DestinationPath $SecondRoot
  $FirstManifest = Get-FileManifest -Root $FirstRoot
  $SecondManifest = Get-FileManifest -Root $SecondRoot
  $Difference = Compare-Object `
    ($FirstManifest | ConvertTo-Json -Depth 4 -Compress) `
    ($SecondManifest | ConvertTo-Json -Depth 4 -Compress)
  if ($Difference) {
    throw "Windows Runtime closures are not byte-for-byte reproducible"
  }
  $NativeHost = $FirstManifest |
    Where-Object { $_.path -eq "bin/bpa-native-host.exe" }
  if (-not $NativeHost) {
    throw "Reproducible closure is missing bin/bpa-native-host.exe"
  }
  Write-Output (
    "Verified reproducible Windows Runtime: {0} files; Native Host {1}" -f `
      $FirstManifest.Count, $NativeHost.sha256
  )
} finally {
  if (Test-Path -LiteralPath $ComparisonRoot) {
    Remove-Item -LiteralPath $ComparisonRoot -Recurse -Force
  }
}
