$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "windows-runtime-common.ps1")

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Sharing-Violation([int]$HResult) {
  return [System.IO.IOException]::new("injected file sharing failure", $HResult)
}

$TestRoot = Join-Path `
  $env:TEMP `
  "bpa-runtime-copy-retry-test-$([Guid]::NewGuid().ToString('N'))"
$InstallRoot = Join-Path $TestRoot "install"
$PackagedRuntime = Join-Path $TestRoot "packaged-runtime"
New-Item -ItemType Directory -Path $InstallRoot, $PackagedRuntime -Force |
  Out-Null
[IO.File]::WriteAllText(
  (Join-Path $PackagedRuntime "runtime.txt"),
  "verified runtime`r`n",
  [Text.UTF8Encoding]::new($false)
)

try {
  foreach ($FailureHResult in @(-2147024864, -2147024863)) {
    $StagingRoot = Join-Path `
      $InstallRoot `
      ".install.$([Guid]::NewGuid().ToString('N'))"
    $script:CopyAttempts = 0
    $script:RetryCallbacks = 0
    $script:InjectedHResult = $FailureHResult
    Copy-BpaPackagedRuntimeForFreshInstall `
      -InstallRoot $InstallRoot `
      -PackagedRuntime $PackagedRuntime `
      -StagingRoot $StagingRoot `
      -CopyOperation {
        param([string]$Source, [string]$Destination)
        $script:CopyAttempts += 1
        if ($script:CopyAttempts -eq 1) {
          New-Item -ItemType Directory -Path $Destination -Force | Out-Null
          [IO.File]::WriteAllText(
            (Join-Path $Destination "partial.txt"),
            "partial`r`n",
            [Text.UTF8Encoding]::new($false)
          )
          throw (Sharing-Violation $script:InjectedHResult)
        }
        Assert-True `
          (-not (Test-Path -LiteralPath (Join-Path $Destination "partial.txt"))) `
          "Partial staging content survived a sharing-violation retry."
        Copy-Item `
          -LiteralPath $Source `
          -Destination $Destination `
          -Recurse `
          -ErrorAction Stop
      } `
      -SleepOperation { param([int]$Milliseconds) } `
      -OnRetry {
        param([int]$Attempt, [int]$AttemptLimit)
        $script:RetryCallbacks += 1
      }
    Assert-True ($script:CopyAttempts -eq 2) "Sharing violation was not retried once."
    Assert-True ($script:RetryCallbacks -eq 1) "Retry callback count is invalid."
    Assert-True `
      (Test-Path -LiteralPath (Join-Path $StagingRoot "runtime.txt")) `
      "Runtime copy did not complete after a sharing violation."
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
  }

  $NonTransientStage = Join-Path `
    $InstallRoot `
    ".install.$([Guid]::NewGuid().ToString('N'))"
  $script:CopyAttempts = 0
  $NonTransient = $null
  try {
    Copy-BpaPackagedRuntimeForFreshInstall `
      -InstallRoot $InstallRoot `
      -PackagedRuntime $PackagedRuntime `
      -StagingRoot $NonTransientStage `
      -CopyOperation {
        param([string]$Source, [string]$Destination)
        $script:CopyAttempts += 1
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        throw ([System.IO.IOException]::new(
          "injected access denied",
          -2147024891
        ))
      } `
      -SleepOperation { param([int]$Milliseconds) }
  } catch {
    $NonTransient = $_.Exception
  }
  Assert-True ($script:CopyAttempts -eq 1) "Non-transient copy failure was retried."
  Assert-True ($null -ne $NonTransient) "Non-transient copy failure was swallowed."
  Assert-True `
    (($NonTransient.HResult -band 0xFFFF) -eq 5) `
    "Non-transient copy failure identity was not preserved."
  Assert-True `
    (-not (Test-Path -LiteralPath $NonTransientStage)) `
    "Partial staging was not removed after a non-transient copy failure."

  $CleanupStage = Join-Path `
    $InstallRoot `
    ".install.$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $CleanupStage -Force | Out-Null
  $script:CleanupAttempts = 0
  try {
    Remove-BpaFreshInstallStaging `
      -InstallRoot $InstallRoot `
      -StagingRoot $CleanupStage `
      -MaximumAttempts 3 `
      -RemoveOperation {
        param([string]$Path)
        $script:CleanupAttempts += 1
        throw (Sharing-Violation -2147024864)
      } `
      -SleepOperation { param([int]$Milliseconds) }
    throw "Cleanup retry limit was not enforced."
  } catch {
    Assert-True `
      (($_.Exception.HResult -band 0xFFFF) -eq 32) `
      "Cleanup retry returned the wrong failure."
  }
  Assert-True ($script:CleanupAttempts -eq 3) "Cleanup retry count exceeded its limit."

  $InvalidStage = Join-Path $InstallRoot ".install.not-a-guid"
  New-Item -ItemType Directory -Path $InvalidStage -Force | Out-Null
  $script:InvalidCleanupAttempts = 0
  try {
    Remove-BpaFreshInstallStaging `
      -InstallRoot $InstallRoot `
      -StagingRoot $InvalidStage `
      -RemoveOperation {
        param([string]$Path)
        $script:InvalidCleanupAttempts += 1
      }
    throw "Invalid staging path was accepted."
  } catch {
    Assert-True `
      ($_.Exception.Message -match "exact BPA install GUID") `
      "Invalid staging path returned an unexpected error."
  }
  Assert-True `
    ($script:InvalidCleanupAttempts -eq 0) `
    "Cleanup ran outside an exact GUID staging directory."
  Assert-True `
    (Test-Path -LiteralPath $InvalidStage) `
    "Invalid staging directory was removed."

  $AggregateStage = Join-Path `
    $InstallRoot `
    ".install.$([Guid]::NewGuid().ToString('N'))"
  $Aggregate = $null
  try {
    Copy-BpaPackagedRuntimeForFreshInstall `
      -InstallRoot $InstallRoot `
      -PackagedRuntime $PackagedRuntime `
      -StagingRoot $AggregateStage `
      -CleanupMaximumAttempts 1 `
      -CopyOperation {
        param([string]$Source, [string]$Destination)
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        throw ([System.IO.IOException]::new(
          "injected access denied",
          -2147024891
        ))
      } `
      -RemoveOperation {
        param([string]$Path)
        throw (Sharing-Violation -2147024864)
      } `
      -SleepOperation { param([int]$Milliseconds) }
  } catch {
    $Aggregate = $_.Exception
  }
  Assert-True `
    ($Aggregate -is [System.AggregateException]) `
    "Copy and cleanup failures were not aggregated."
  Assert-True `
    ($Aggregate.InnerExceptions.Count -eq 2) `
    "Aggregate failure did not retain both exceptions."
  Assert-True `
    (($Aggregate.InnerExceptions[0].HResult -band 0xFFFF) -eq 5) `
    "Aggregate failure lost the primary copy error."
  Assert-True `
    (($Aggregate.InnerExceptions[1].HResult -band 0xFFFF) -eq 32) `
    "Aggregate failure lost the cleanup error."

  Write-Host "Verified bounded Windows Runtime copy and cleanup retries."
} finally {
  if (Test-Path -LiteralPath $TestRoot) {
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
  }
}
