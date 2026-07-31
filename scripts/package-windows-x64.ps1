[CmdletBinding()]
param(
  [string]$Output
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "BPA Windows release must be built on Windows x64."
}
if ((node -p 'process.platform + ":" + process.arch + ":" + process.versions.node.split(".")[0]') -ne "win32:x64:24") {
  throw "BPA Windows release must use Node.js 24 x64."
}
if (git status --porcelain=v1 --untracked-files=no) {
  throw "Release packages must be built from a clean tracked Git checkout."
}

$RuntimeVersion = node -p 'require("./package.json").version'
$NodeVersion = node -p 'process.versions.node'
$GitCommit = git rev-parse HEAD
$ReleaseIdentity = "v$RuntimeVersion-rc.$($GitCommit.Substring(0, 12))"
$ExpectedName = "bpa-local-$ReleaseIdentity-windows-x64.zip"
if (-not $Output) {
  $Output = Join-Path $ProjectRoot "artifacts\$ExpectedName"
}
$Output = [IO.Path]::GetFullPath($Output)
if ((Split-Path -Leaf $Output) -ne $ExpectedName) {
  throw "Release archive must be named $ExpectedName."
}
if (Test-Path -LiteralPath $Output) {
  throw "Release output already exists and will not be overwritten."
}

pnpm verify
if ($LASTEXITCODE -ne 0) {
  throw "Repository verification failed."
}
node --test (Join-Path $ProjectRoot "scripts\release-gates.check.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Release gate tests failed."
}

$PackageRoot = Join-Path $env:RUNNER_TEMP "bpa-windows-$([Guid]::NewGuid().ToString('N'))"
if (-not $env:RUNNER_TEMP) {
  $PackageRoot = Join-Path $env:TEMP "bpa-windows-$([Guid]::NewGuid().ToString('N'))"
}
$BpaRoot = Join-Path $PackageRoot "bpa"
$RuntimeRoot = Join-Path $BpaRoot "runtime"
$SeaRoot = Join-Path $PackageRoot "sea"
New-Item -ItemType Directory -Path $BpaRoot, $SeaRoot -Force | Out-Null

try {
  $SeaBundle = Join-Path $SeaRoot "bpa-native-host.cjs"
  pnpm exec esbuild `
    (Join-Path $ProjectRoot "apps\native-host\src\main.ts") `
    --bundle `
    --platform=node `
    --format=cjs `
    --target=node24 `
    "--outfile=$SeaBundle"
  if ($LASTEXITCODE -ne 0) {
    throw "Native Host SEA bundle failed."
  }
  $SeaConfig = @{
    main = $SeaBundle
    output = (Join-Path $SeaRoot "sea-prep.blob")
    disableExperimentalSEAWarning = $true
    useSnapshot = $false
    useCodeCache = $false
  } | ConvertTo-Json
  Set-Content `
    -LiteralPath (Join-Path $SeaRoot "sea-config.json") `
    -Value $SeaConfig `
    -Encoding utf8NoBOM
  node --experimental-sea-config (Join-Path $SeaRoot "sea-config.json")
  if ($LASTEXITCODE -ne 0) {
    throw "Native Host SEA preparation failed."
  }
  $NativeHostExe = Join-Path $SeaRoot "bpa-native-host.exe"
  Copy-Item -LiteralPath (Get-Command node).Source -Destination $NativeHostExe
  pnpm exec postject `
    $NativeHostExe `
    NODE_SEA_BLOB `
    (Join-Path $SeaRoot "sea-prep.blob") `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  if ($LASTEXITCODE -ne 0) {
    throw "Native Host SEA injection failed."
  }

  $SqliteBinary = node -p 'require.resolve("better-sqlite3/build/Release/better_sqlite3.node")'
  $env:BPA_TARGET_PLATFORM = "win32"
  $env:BPA_TARGET_ARCHITECTURE = "x64"
  $env:BPA_TARGET_NODE_VERSION = $NodeVersion
  $env:BPA_TARGET_NODE_EXECUTABLE = (Get-Command node).Source
  $env:BPA_TARGET_SQLITE_BINARY = $SqliteBinary
  $env:BPA_TARGET_NATIVE_HOST_EXECUTABLE = $NativeHostExe
  node (Join-Path $ProjectRoot "scripts\build-runtime-closure.mjs") $RuntimeRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Windows runtime closure build failed."
  }

  Copy-Item `
    -LiteralPath (Join-Path $ProjectRoot "scripts\install-windows-x64.ps1") `
    -Destination (Join-Path $BpaRoot "install.ps1")
  Copy-Item `
    -LiteralPath (Join-Path $ProjectRoot "scripts\rollback-windows.ps1") `
    -Destination (Join-Path $BpaRoot "rollback.ps1")
  Copy-Item `
    -LiteralPath (Join-Path $ProjectRoot "scripts\uninstall-windows.ps1") `
    -Destination (Join-Path $BpaRoot "uninstall.ps1")

  Push-Location $RuntimeRoot
  try {
    & (Join-Path $RuntimeRoot "node\node.exe") `
      (Join-Path $RuntimeRoot "bin\bpa-runtime-verify.js") `
      $RuntimeRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Packaged runtime verification failed."
    }
    & (Join-Path $RuntimeRoot "node\node.exe") -e `
      'import("better-sqlite3").then(({default: Database}) => new Database(":memory:").close())'
    if ($LASTEXITCODE -ne 0) {
      throw "Packaged SQLite binary verification failed."
    }
    $VerifyHome = Join-Path $PackageRoot "verify-home"
    $env:BPA_HOME = $VerifyHome
    & (Join-Path $RuntimeRoot "node\node.exe") `
      (Join-Path $RuntimeRoot "bin\bpa-core.js") --migrate-only
    if ($LASTEXITCODE -ne 0) {
      throw "Packaged migration verification failed."
    }
  } finally {
    Pop-Location
  }
  & (Join-Path $RuntimeRoot "node\node.exe") `
    (Join-Path $RuntimeRoot "bin\bpa-release-scan.js") `
    $BpaRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Packaged release scan failed."
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $Output) -Force |
    Out-Null
  Compress-Archive -LiteralPath $BpaRoot -DestinationPath $Output
  $Digest = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(
    "$Output.sha256",
    "$Digest  $(Split-Path -Leaf $Output)`r`n",
    [Text.Encoding]::ASCII
  )
  & (Join-Path $ProjectRoot "scripts\verify-package-windows-x64.ps1") $Output
  if ($LASTEXITCODE -ne 0) {
    throw "Windows package verification failed."
  }
  Write-Output $Output
} finally {
  if (Test-Path -LiteralPath $PackageRoot) {
    Remove-Item -LiteralPath $PackageRoot -Recurse -Force
  }
}
