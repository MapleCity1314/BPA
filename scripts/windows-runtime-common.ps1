$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-BpaRuntimeIdentity {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PointerPath
  )
  if (-not (Test-Path -LiteralPath $PointerPath -PathType Leaf)) {
    throw "BPA runtime pointer is missing: $PointerPath"
  }
  $Identity = (Get-Content -LiteralPath $PointerPath -Raw).Trim()
  if (
    $Identity -notmatch
      "^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[a-f0-9]{12}(?:\.node24\.[0-9]+\.[0-9]+)?$"
  ) {
    throw "BPA runtime pointer contains an invalid identity."
  }
  return $Identity
}

function Set-BpaRuntimePointer {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PointerPath,
    [Parameter(Mandatory = $true)]
    [string]$Identity
  )
  if (
    $Identity -notmatch
      "^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[a-f0-9]{12}(?:\.node24\.[0-9]+\.[0-9]+)?$"
  ) {
    throw "Refusing to write an invalid BPA runtime identity."
  }
  $Next = "$PointerPath.next"
  [IO.File]::WriteAllText(
    $Next,
    "$Identity`r`n",
    [Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $Next -Destination $PointerPath -Force
}

function Read-BpaCoreLock {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LockPath
  )
  if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
    return $null
  }
  $Content = (Get-Content -LiteralPath $LockPath -Raw).Trim()
  $LegacyPid = 0
  if ([int]::TryParse($Content, [ref]$LegacyPid) -and $LegacyPid -gt 0) {
    return [pscustomobject]@{
      Version = 0
      Pid = $LegacyPid
      RuntimeIdentity = $null
      ExecutablePath = $null
      EntryPointPath = $null
    }
  }
  try {
    $Record = $Content | ConvertFrom-Json
  } catch {
    throw "BPA Core lock is malformed; refusing to terminate any process."
  }
  $Names = @($Record.PSObject.Properties.Name)
  if (
    $Record.version -ne 1 -or
    $Names -notcontains "pid" -or
    [int]$Record.pid -le 0 -or
    $Names -notcontains "instanceToken" -or
    [string]::IsNullOrWhiteSpace([string]$Record.instanceToken)
  ) {
    throw "BPA Core lock identity is invalid; refusing to terminate any process."
  }
  $RuntimeIdentity = $null
  $ExecutablePath = $null
  $EntryPointPath = $null
  if ($Names -contains "runtimeIdentity") {
    $RuntimeIdentity = [string]$Record.runtimeIdentity
  }
  if ($Names -contains "executablePath") {
    $ExecutablePath = [string]$Record.executablePath
  }
  if ($Names -contains "entryPointPath") {
    $EntryPointPath = [string]$Record.entryPointPath
  }
  return [pscustomobject]@{
    Version = 1
    Pid = [int]$Record.pid
    RuntimeIdentity = $RuntimeIdentity
    ExecutablePath = $ExecutablePath
    EntryPointPath = $EntryPointPath
  }
}

function Test-BpaPathEqual {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
  return [string]::Equals(
    [IO.Path]::GetFullPath($Left).TrimEnd("\"),
    [IO.Path]::GetFullPath($Right).TrimEnd("\"),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Stop-BpaCoreSafely {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [string]$ExpectedRuntimeIdentity
  )
  $LockPath = Join-Path $InstallRoot "run\core.lock"
  $Lock = Read-BpaCoreLock -LockPath $LockPath
  if ($null -eq $Lock) {
    return
  }
  $ProcessInfo = Get-CimInstance `
    -ClassName Win32_Process `
    -Filter "ProcessId = $($Lock.Pid)" `
    -ErrorAction SilentlyContinue
  if ($null -eq $ProcessInfo) {
    Remove-Item -LiteralPath $LockPath -Force
    return
  }
  $Identity = $ExpectedRuntimeIdentity
  if (-not [string]::IsNullOrWhiteSpace($Lock.RuntimeIdentity)) {
    $Identity = $Lock.RuntimeIdentity
  }
  if (
    $Identity -notmatch
      "^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[a-f0-9]{12}(?:\.node24\.[0-9]+\.[0-9]+)?$"
  ) {
    throw "BPA Core runtime identity cannot be verified; refusing to stop PID $($Lock.Pid)."
  }
  if (
    -not [string]::IsNullOrWhiteSpace($ExpectedRuntimeIdentity) -and
    $Identity -ne $ExpectedRuntimeIdentity
  ) {
    throw "BPA Core lock belongs to runtime $Identity, not $ExpectedRuntimeIdentity."
  }
  $ExpectedExecutable = Join-Path $InstallRoot "runtime\$Identity\node\node.exe"
  $ExpectedEntryPoint = Join-Path $InstallRoot "runtime\$Identity\bin\bpa-core.js"
  $ExecutableMatches = Test-BpaPathEqual `
    -Left ([string]$ProcessInfo.ExecutablePath) `
    -Right $ExpectedExecutable
  $CommandLine = [string]$ProcessInfo.CommandLine
  $EntryPointMatches =
    $CommandLine.IndexOf($ExpectedEntryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $LockPathsMatch =
    ($Lock.Version -eq 0) -or
    (
      (Test-BpaPathEqual -Left $Lock.ExecutablePath -Right $ExpectedExecutable) -and
      (Test-BpaPathEqual -Left $Lock.EntryPointPath -Right $ExpectedEntryPoint)
    )
  if (-not $ExecutableMatches -or -not $EntryPointMatches -or -not $LockPathsMatch) {
    throw "PID $($Lock.Pid) does not match the recorded BPA Core executable; refusing to terminate it."
  }
  Stop-Process -Id $Lock.Pid
  $Process = Get-Process -Id $Lock.Pid -ErrorAction SilentlyContinue
  if ($Process) {
    $Process.WaitForExit(5000)
  }
  if (Get-Process -Id $Lock.Pid -ErrorAction SilentlyContinue) {
    throw "BPA Core PID $($Lock.Pid) did not stop cleanly."
  }
  if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
    Remove-Item -LiteralPath $LockPath -Force
  }
}

function Start-BpaCoreProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [Parameter(Mandatory = $true)]
    [string]$RuntimeIdentity
  )
  $RuntimeRoot = Join-Path $InstallRoot "runtime\$RuntimeIdentity"
  $Node = Join-Path $RuntimeRoot "node\node.exe"
  $EntryPoint = Join-Path $RuntimeRoot "bin\bpa-core.js"
  $Launcher = Join-Path $RuntimeRoot "bin\bpa-core-launcher.js"
  if (
    -not (Test-Path -LiteralPath $Node -PathType Leaf) -or
    -not (Test-Path -LiteralPath $EntryPoint -PathType Leaf)
  ) {
    throw "BPA Core runtime is incomplete: $RuntimeIdentity"
  }
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
    throw "BPA detached Core launcher is missing: $Launcher"
  }
  # The fixed launcher owns Windows handle isolation. It starts Core detached
  # with explicit file logs, then exits so WorkBuddy receives EOF immediately.
  $PreviousHome = $env:BPA_HOME
  $PreviousRuntimeIdentity = $env:BPA_RUNTIME_ID
  try {
    $env:BPA_HOME = $InstallRoot
    $env:BPA_RUNTIME_ID = $RuntimeIdentity
    & $Node $Launcher
    if ($LASTEXITCODE -ne 0) {
      throw "BPA detached Core launcher exited with code $LASTEXITCODE."
    }
    Start-Sleep -Milliseconds 250
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "run\core.lock"))) {
      throw "BPA Core exited before creating its identity lock."
    }
  } finally {
    $env:BPA_HOME = $PreviousHome
    $env:BPA_RUNTIME_ID = $PreviousRuntimeIdentity
  }
}

function Wait-BpaCoreHealthy {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [Parameter(Mandatory = $true)]
    [string]$RuntimeIdentity,
    [int]$Attempts = 3
  )
  $RuntimeRoot = Join-Path $InstallRoot "runtime\$RuntimeIdentity"
  $PreviousHome = $env:BPA_HOME
  try {
    $env:BPA_HOME = $InstallRoot
    for ($Attempt = 0; $Attempt -lt $Attempts; $Attempt += 1) {
      Start-Sleep -Milliseconds 250
      try {
        & (Join-Path $RuntimeRoot "node\node.exe") `
          (Join-Path $RuntimeRoot "bin\bpa.js") doctor *> $null
        if ($LASTEXITCODE -eq 0) {
          return
        }
      } catch {
        continue
      }
    }
  } finally {
    $env:BPA_HOME = $PreviousHome
  }
  $LockPath = Join-Path $InstallRoot "run\core.lock"
  $LockState = if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
    "present"
  } else {
    "missing"
  }
  $ErrorLog = Join-Path $InstallRoot "logs\core.err.log"
  $ErrorTail = if (Test-Path -LiteralPath $ErrorLog -PathType Leaf) {
    @(
      Get-Content -LiteralPath $ErrorLog -Tail 20 -ErrorAction SilentlyContinue
    ) -join " | "
  } else {
    "missing"
  }
  if ([string]::IsNullOrWhiteSpace($ErrorTail)) {
    $ErrorTail = "empty"
  }
  throw (
    "BPA Core health check did not complete for $RuntimeIdentity. " +
    "Lock=$LockState; stderr=$ErrorTail"
  )
}
