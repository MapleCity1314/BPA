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
  $FirstByPath = @{}
  $SecondByPath = @{}
  foreach ($Entry in $FirstManifest) { $FirstByPath[$Entry.path] = $Entry }
  foreach ($Entry in $SecondManifest) { $SecondByPath[$Entry.path] = $Entry }
  $Paths = @($FirstByPath.Keys + $SecondByPath.Keys | Sort-Object -Unique)
  $Differences = @(
    foreach ($Path in $Paths) {
      $FirstEntry = $FirstByPath[$Path]
      $SecondEntry = $SecondByPath[$Path]
      if (
        -not $FirstEntry -or
        -not $SecondEntry -or
        $FirstEntry.size -ne $SecondEntry.size -or
        $FirstEntry.sha256 -ne $SecondEntry.sha256
      ) {
        [PSCustomObject]@{
          path = $Path
          firstSize = $(if ($FirstEntry) { $FirstEntry.size } else { $null })
          firstSha256 = $(if ($FirstEntry) { $FirstEntry.sha256 } else { $null })
          secondSize = $(if ($SecondEntry) { $SecondEntry.size } else { $null })
          secondSha256 = $(if ($SecondEntry) { $SecondEntry.sha256 } else { $null })
        }
      }
    }
  )
  if ($Differences.Count -gt 0) {
    Write-Error ($Differences | Select-Object -First 20 | ConvertTo-Json -Depth 4)
    throw (
      "Windows Runtime closures differ in {0} file(s)" -f $Differences.Count
    )
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
