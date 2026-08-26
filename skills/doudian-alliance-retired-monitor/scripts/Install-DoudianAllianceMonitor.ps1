[CmdletBinding()]
param(
  [string]$SkillRoot = (
    Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
  ),
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "BPA"),
  [string]$RecordsRoot = (
    Join-Path (
      [Environment]::GetFolderPath("MyDocuments")
    ) "WorkBuddy\精选联盟清退巡检记录"
  ),
  [string]$BrowserSessionId,
  [string]$BrowserInstanceId,
  [string]$ResultPath,
  [switch]$OpenBrowserSetup,
  [switch]$ValidatePackageOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest
$DeploymentStage = $null
$InstallTracePath = Join-Path $InstallRoot "logs\workbuddy-install.log"

function Write-InstallTrace([string]$Stage, [string]$Detail = "") {
  $TraceDirectory = Split-Path -Parent $script:InstallTracePath
  New-Item -ItemType Directory -Path $TraceDirectory -Force | Out-Null
  $Line = "{0}`t{1}`t{2}`r`n" -f `
    (Get-Date).ToUniversalTime().ToString("o"), `
    $Stage, `
    $Detail.Replace("`r", " ").Replace("`n", " ")
  [IO.File]::AppendAllText(
    $script:InstallTracePath,
    $Line,
    [Text.UTF8Encoding]::new($false)
  )
}

function Get-OptionalProperty(
  [object]$InputObject,
  [string]$Name,
  [object]$DefaultValue = $null
) {
  if ($null -eq $InputObject) {
    return $DefaultValue
  }
  $Property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $Property) {
    return $DefaultValue
  }
  return $Property.Value
}

function ConvertFrom-JsonItems([string]$Json) {
  $Parsed = $Json | ConvertFrom-Json
  if ($null -eq $Parsed) {
    return @()
  }
  return @($Parsed)
}

function Write-JsonResult([hashtable]$Value) {
  if (
    $null -ne $script:DeploymentStage -and
    (Test-Path -LiteralPath $script:DeploymentStage)
  ) {
    Remove-Item -LiteralPath $script:DeploymentStage -Recurse -Force
    $script:DeploymentStage = $null
  }
  $Json = "$($Value | ConvertTo-Json -Depth 8)`r`n"
  Write-InstallTrace "result" ([string]$Value.status)
  if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    $ResolvedResultPath = [IO.Path]::GetFullPath($ResultPath)
    $ResultDirectory = Split-Path -Parent $ResolvedResultPath
    New-Item -ItemType Directory -Path $ResultDirectory -Force | Out-Null
    $TemporaryResult = "$ResolvedResultPath.tmp-$PID"
    [IO.File]::WriteAllText(
      $TemporaryResult,
      $Json,
      [Text.UTF8Encoding]::new($false)
    )
    Move-Item `
      -LiteralPath $TemporaryResult `
      -Destination $ResolvedResultPath `
      -Force
    return
  }
  Write-Output $Json.TrimEnd()
}

trap {
  $InstallMessage = $_.Exception.Message
  $InstallErrorCode = "INSTALLER_FAILED"
  if (
    $InstallMessage -match
      "(?:^|\b)((?:BPA|BROWSER|SQLITE|WORKFLOW|RUNTIME|SKILL)_[A-Z0-9_]+)(?:\b|:)"
  ) {
    $InstallErrorCode = $Matches[1]
  }
  Write-JsonResult @{
    schemaVersion = 1
    status = "install_failed"
    errorCode = $InstallErrorCode
    message = $InstallMessage
    requiredHumanActions = @(
      "停止安装，不要修改或绕过 Runtime、数据库、校验和、版本指针或扩展文件。",
      "保留本 JSON 和安装日志，使用原始 Skill 包重新验收或交给 BPA 开发修复。"
    )
  }
  exit 2
}

function Invoke-Bpa(
  [string]$BpaCommand,
  [string[]]$Arguments,
  [string]$Operation
) {
  $Lines = @(& $BpaCommand @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $Detail = ($Lines | ForEach-Object { [string]$_ }) -join "`n"
    throw "$Operation failed: $Detail"
  }
  return ($Lines | ForEach-Object { [string]$_ }) -join "`n"
}

function Resolve-Chrome {
  $Candidates = @()
  if ($env:ProgramFiles) {
    $Candidates += Join-Path `
      $env:ProgramFiles `
      "Google\Chrome\Application\chrome.exe"
  }
  if (${env:ProgramFiles(x86)}) {
    $Candidates += Join-Path `
      ${env:ProgramFiles(x86)} `
      "Google\Chrome\Application\chrome.exe"
  }
  if ($env:LOCALAPPDATA) {
    $Candidates += Join-Path `
      $env:LOCALAPPDATA `
      "Google\Chrome\Application\chrome.exe"
  }
  foreach ($Candidate in $Candidates) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
      return $Candidate
    }
  }
  $Command = Get-Command "chrome.exe" -ErrorAction SilentlyContinue
  if ($Command) {
    return $Command.Source
  }
  return $null
}

function Open-BrowserSetup {
  $Chrome = Resolve-Chrome
  if (-not $Chrome) {
    return $false
  }
  Start-Process -FilePath $Chrome -ArgumentList "chrome://extensions/"
  Start-Process `
    -FilePath $Chrome `
    -ArgumentList "https://fxg.jinritemai.com/ffa/g/list"
  return $true
}

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is required."
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "This installer requires 64-bit Windows."
}
if (-not (Test-Path -LiteralPath $SkillRoot -PathType Container)) {
  throw "Skill root does not exist: $SkillRoot"
}
Write-InstallTrace "started" "validatePackageOnly=$ValidatePackageOnly"

$AssetsRoot = Join-Path $SkillRoot "assets"
$RuntimeRoot = Join-Path $AssetsRoot "windows-x64"
$WorkflowAssetsRoot = Join-Path $AssetsRoot "workflow-assets"
$RuntimeArchives = @(
  Get-ChildItem `
    -LiteralPath $RuntimeRoot `
    -Filter "bpa-local-*-windows-x64.zip" `
    -File
)
if ($RuntimeArchives.Count -ne 1) {
  throw "The Skill must contain exactly one Windows x64 BPA Runtime archive."
}
$RuntimeArchive = $RuntimeArchives[0].FullName
$RuntimeChecksum = "$RuntimeArchive.sha256"
if (-not (Test-Path -LiteralPath $RuntimeChecksum -PathType Leaf)) {
  throw "The Runtime SHA-256 file is missing."
}
$ExpectedDigest = (
  (Get-Content -LiteralPath $RuntimeChecksum -Raw).Trim() -split "\s+"
)[0].ToLowerInvariant()
$ActualDigest = (
  Get-FileHash -LiteralPath $RuntimeArchive -Algorithm SHA256
).Hash.ToLowerInvariant()
if ($ExpectedDigest -ne $ActualDigest) {
  throw "The Runtime SHA-256 does not match."
}
Write-InstallTrace "runtime-archive-verified"

$RequiredAssets = @(
  @{
    type = "node"
    file = "doudian.alliance.shops.discover.node.yaml"
    sha256 = "7d51e8feea778f3792228cb88350f251be48b4f1c9c25f3215996f3549bb131f"
  },
  @{
    type = "node"
    file = "doudian.alliance.shop.retired-products.scan.node.yaml"
    sha256 = "3c6d9b98494f7369877f2f0273cf38b865f5c5a6c51f4b5435a2c495c24a9e47"
  },
  @{
    type = "node"
    file = "doudian.alliance.shop.retired-products.fact.persist.node.yaml"
    sha256 = "99a41085abb01818ffbf9084c0dab4f4c9b856305d9759cb0f1ef9ccffc7c739"
  },
  @{
    type = "node"
    file = "doudian.alliance.retired-products.aggregate.node.yaml"
    sha256 = "8b75686f797c21d71d6f099818ae2f4219d03ec4daf968645b777a948cc8aaf6"
  },
  @{
    type = "node"
    file = "doudian.alliance.retired-products.dataset.prepare.node.yaml"
    sha256 = "176f386bb4c0e0585d76f0265927b56948f4993ddcf415b1355ce1e413381ad3"
  },
  @{
    type = "adapter"
    file = "doudian-alliance.adapter.yaml"
    sha256 = "ae9c7ffe9f02b299d904b234623d6743a7478b708fb6c2f0557da51760650c91"
  },
  @{
    type = "workflow"
    file = "doudian.alliance-retired-products-monitor.workflow.yaml"
    sha256 = "d2af4a316b1beca1b50427a7952b9ac1e92112f42f5ec156cc9c8f8f51da7fdf"
  }
)
foreach ($Asset in $RequiredAssets) {
  $AssetPath = Join-Path $WorkflowAssetsRoot $Asset.file
  if (-not (Test-Path -LiteralPath $AssetPath -PathType Leaf)) {
    throw "Required $($Asset.type) asset is missing: $($Asset.file)"
  }
  $AssetDigest = (
    Get-FileHash -LiteralPath $AssetPath -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  if ($AssetDigest -ne $Asset.sha256) {
    throw "Required $($Asset.type) asset failed SHA-256 verification."
  }
}

$Stage = Join-Path `
  $env:TEMP `
  "bpa-workbuddy-install-$([Guid]::NewGuid().ToString('N'))"
$RuntimeInstalled = $false
try {
  Expand-Archive -LiteralPath $RuntimeArchive -DestinationPath $Stage
  $PackageRoot = Join-Path $Stage "bpa"
  $RuntimeManifestPath = Join-Path `
    (Join-Path $PackageRoot "runtime") `
    "runtime-manifest.json"
  if (-not (Test-Path -LiteralPath $RuntimeManifestPath -PathType Leaf)) {
    throw "The Runtime manifest is missing from the archive."
  }
  $RuntimeManifest = Get-Content -LiteralPath $RuntimeManifestPath -Raw |
    ConvertFrom-Json
  if (
    $RuntimeManifest.platform -ne "win32" -or
    $RuntimeManifest.architecture -ne "x64" -or
    [string]$RuntimeManifest.nodeVersion -ne "24.18.0"
  ) {
    throw "The embedded Runtime is not the pinned Windows x64 Node.js 24.18.0 build."
  }
  $RequiredIdentity = [string]$RuntimeManifest.release.identity
  if ($ValidatePackageOnly) {
    Write-JsonResult @{
      schemaVersion = 1
      status = "package_verified"
      runtimeIdentity = $RequiredIdentity
      runtimeSha256 = $ActualDigest
      assets = @(
        $RequiredAssets | ForEach-Object {
          @{
            type = $_.type
            file = $_.file
            sha256 = $_.sha256
          }
        }
      )
    }
    return
  }
  $CurrentPointer = Join-Path $InstallRoot "runtime\current.txt"
  $CurrentIdentity = $null
  if (Test-Path -LiteralPath $CurrentPointer -PathType Leaf) {
    $CurrentIdentity = (
      Get-Content -LiteralPath $CurrentPointer -Raw
    ).Trim()
  }
  Write-InstallTrace "runtime-install-started" $RequiredIdentity
  $RuntimeInstallerOutput = @(
    & (Join-Path $PackageRoot "install.ps1") `
      -InstallRoot $InstallRoot `
      -TracePath (Join-Path $InstallRoot "logs\runtime-install.log") `
      *>&1
  )
  if ($LASTEXITCODE -ne 0) {
    $RuntimeInstallerDetail = (
      $RuntimeInstallerOutput |
        Select-Object -Last 20 |
        ForEach-Object { [string]$_ }
    ) -join "`n"
    throw (
      "The BPA Runtime installer exited with code $LASTEXITCODE." +
      " $RuntimeInstallerDetail"
    )
  }
  Write-InstallTrace "runtime-install-completed" $RequiredIdentity
  $RuntimeInstalled = $CurrentIdentity -ne $RequiredIdentity
} finally {
  if (Test-Path -LiteralPath $Stage) {
    Remove-Item -LiteralPath $Stage -Recurse -Force
  }
}

$BpaCommand = Join-Path $InstallRoot "bin\bpa.cmd"
if (-not (Test-Path -LiteralPath $BpaCommand -PathType Leaf)) {
  throw "The BPA command was not installed."
}
$DoctorText = Invoke-Bpa $BpaCommand @("doctor") "BPA health check"
$Doctor = $DoctorText | ConvertFrom-Json
Write-InstallTrace "doctor-completed"

New-Item -ItemType Directory -Path $RecordsRoot -Force | Out-Null
$WorkBuddyRoot = Join-Path $InstallRoot "workbuddy"
New-Item -ItemType Directory -Path $WorkBuddyRoot -Force | Out-Null
$DeploymentStage = Join-Path `
  $WorkBuddyRoot `
  ".deployment-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $DeploymentStage -Force | Out-Null
$AutomationPromptSource = Join-Path `
  $SkillRoot `
  "references\workbuddy-automation-prompt.md"
$AutomationPromptDigest = (
  Get-FileHash -LiteralPath $AutomationPromptSource -Algorithm SHA256
).Hash.ToLowerInvariant()
if (
  $AutomationPromptDigest -ne
    "135bc08aa42dd43056584ddb52866b346b6e6604432f0c3a7258b14dc2e38ff3"
) {
  throw "The WorkBuddy automation prompt failed SHA-256 verification."
}
$AutomationPromptFinal = Join-Path `
  $WorkBuddyRoot `
  "workbuddy-automation-prompt.md"
$AutomationPromptTarget = Join-Path `
  $DeploymentStage `
  "workbuddy-automation-prompt.md"
Copy-Item `
  -LiteralPath $AutomationPromptSource `
  -Destination $AutomationPromptTarget `
  -Force

$SessionsText = Invoke-Bpa `
  $BpaCommand `
  @("browser-sessions", "--limit", "100") `
  "Read browser sessions"
$Sessions = @(ConvertFrom-JsonItems $SessionsText)
Write-InstallTrace "browser-sessions-read" ([string]$Sessions.Count)
$CapableSessions = @(
  $Sessions | Where-Object {
    $DisconnectedAt = Get-OptionalProperty $_ "disconnectedAt"
    $CapabilityDigest = Get-OptionalProperty $_ "capabilityDigest"
    $Capabilities = @(Get-OptionalProperty $_ "capabilities" @())
    -not $DisconnectedAt -and $CapabilityDigest -and
    @($Capabilities | Where-Object {
      $_.nodeId -eq "doudian.alliance.shops.discover" -and
      $_.nodeVersion -eq "2.0.15"
    }).Count -gt 0
  }
)
$PagesText = Invoke-Bpa `
  $BpaCommand `
  @("browser-pages", "--limit", "200") `
  "Read browser page observations"
$Pages = @(ConvertFrom-JsonItems $PagesText)
Write-InstallTrace "browser-pages-read" ([string]$Pages.Count)
$SelectedInstanceId = $BrowserInstanceId
if ($BrowserSessionId) {
  $LegacySession = @(
    $CapableSessions | Where-Object { $_.id -eq $BrowserSessionId }
  ) | Select-Object -First 1
  if (-not $LegacySession) {
    throw "BROWSER_BRIDGE_DISCONNECTED"
  }
  $SelectedInstanceId = [string]$LegacySession.browserInstanceId
}
$InstanceIds = @(
  $CapableSessions |
    ForEach-Object { [string]$_.browserInstanceId } |
    Sort-Object -Unique
)
if (-not $SelectedInstanceId -and $InstanceIds.Count -eq 1) {
  $SelectedInstanceId = $InstanceIds[0]
}
$SelectedSessionIds = @(
  $CapableSessions |
    Where-Object { $_.browserInstanceId -eq $SelectedInstanceId } |
    ForEach-Object { [string]$_.id }
)
$SourcePages = @(
  $Pages | Where-Object {
    $SelectedSessionIds -contains ([string]$_.sessionId) -and
    $_.origin -eq "https://fxg.jinritemai.com" -and
    $_.pathname -eq "/ffa/g/list"
  } | Sort-Object observedAt -Descending
)
$RelatedDoudianPages = @(
  $Pages | Where-Object {
    $SelectedSessionIds -contains ([string]$_.sessionId) -and
    $_.origin -eq "https://fxg.jinritemai.com"
  } | Sort-Object observedAt -Descending
)
$FreshObservationCutoff = (Get-Date).ToUniversalTime().AddSeconds(-30)
$ReadyPages = @(
  $SourcePages | Where-Object {
    ([DateTime]$_.observedAt).ToUniversalTime() -ge
      $FreshObservationCutoff -and
    $_.contentScriptReady -eq $true -and
    @("authenticated", "membership") -contains $_.authentication -and
    $_.observationState -eq "ready" -and
    (Get-OptionalProperty $_ "authenticationContextRef")
  }
)
$ReadyAuthenticationContexts = @(
  $ReadyPages |
    ForEach-Object {
      [string](Get-OptionalProperty $_ "authenticationContextRef")
    } |
    Sort-Object -Unique
)

$ConfigurationFinal = Join-Path `
  $WorkBuddyRoot `
  "doudian-alliance-retired-monitor.json"
$ConfigurationPath = Join-Path `
  $DeploymentStage `
  "doudian-alliance-retired-monitor.json"
$ExistingBrowserInstanceId = $null
if (Test-Path -LiteralPath $ConfigurationFinal -PathType Leaf) {
  try {
    $ExistingConfiguration = Get-Content -LiteralPath $ConfigurationFinal -Raw |
      ConvertFrom-Json
    $ExistingBrowserInstanceId = Get-OptionalProperty `
      $ExistingConfiguration `
      "browserInstanceId"
  } catch {
    $ExistingBrowserInstanceId = $null
  }
}
$Configuration = [ordered]@{
  schemaVersion = 1
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  runtimeIdentity = $RequiredIdentity
  bpaCommand = $BpaCommand
  recordsDir = $RecordsRoot
  workflow = "doudian.alliance-retired-products-monitor@3.0.16"
  maxShops = 100
  schedule = "daily 13:00"
  timezone = "Asia/Shanghai"
  browserInstanceId = if ($SelectedInstanceId) {
    $SelectedInstanceId
  } else {
    $ExistingBrowserInstanceId
  }
}
$ConfigurationTemporary = "$ConfigurationPath.next"
[IO.File]::WriteAllText(
  $ConfigurationTemporary,
  "$($Configuration | ConvertTo-Json -Depth 5)`r`n",
  [Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $ConfigurationTemporary -Destination $ConfigurationPath -Force

$RunnerFinal = Join-Path $WorkBuddyRoot "Run-DoudianAllianceMonitor.ps1"
$RunnerPath = Join-Path $DeploymentStage "Run-DoudianAllianceMonitor.ps1"
$Runner = @'
[CmdletBinding()]
param(
  [int]$MaxShops = 0,
  [string]$ConfigurationPath = (
    Join-Path $env:LOCALAPPDATA "BPA\workbuddy\doudian-alliance-retired-monitor.json"
  )
)
$ErrorActionPreference = "Stop"
$Configuration = Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json
$EffectiveMaxShops = if ($MaxShops -gt 0) {
  $MaxShops
} else {
  [int]$Configuration.maxShops
}
$InputFile = Join-Path `
  $env:TEMP `
  "bpa-alliance-input-$PID-$([Guid]::NewGuid().ToString('N')).json"
$InputJson = @{ maxShops = $EffectiveMaxShops } | ConvertTo-Json -Compress
[IO.File]::WriteAllText(
  $InputFile,
  $InputJson,
  [Text.UTF8Encoding]::new($false)
)
$Arguments = @(
  "workflow-run",
  "doudian.alliance-retired-products-monitor",
  "--version", "3.0.16",
  "--input-file", $InputFile,
  "--wait-seconds", "28800"
)
if ($Configuration.browserInstanceId) {
  $Arguments += @(
    "--browser-instance-id",
    [string]$Configuration.browserInstanceId
  )
}
$RecordedAt = (Get-Date).ToUniversalTime().ToString("o")
$Shanghai = [TimeZoneInfo]::FindSystemTimeZoneById("China Standard Time")
$BusinessDate = [TimeZoneInfo]::ConvertTimeFromUtc(
  (Get-Date).ToUniversalTime(),
  $Shanghai
).ToString("yyyy-MM-dd")
$Run = $null
$RuntimeError = $null
$RunError = $null
try {
  $RunText = & ([string]$Configuration.bpaCommand) @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($RunText -join "`n")
  }
  $Run = ($RunText -join "`n") | ConvertFrom-Json
} catch {
  $RuntimeError = $_.Exception.Message
} finally {
  if (Test-Path -LiteralPath $InputFile) {
    Remove-Item -LiteralPath $InputFile -Force
  }
}
if ($Run -and $Run.status -ne "succeeded") {
  try {
    $EventsText = & ([string]$Configuration.bpaCommand) `
      "events" `
      ([string]$Run.id) `
      2>&1
    if ($LASTEXITCODE -eq 0) {
      $Events = @(($EventsText -join "`n") | ConvertFrom-Json)
      $FailureEvents = @(
        $Events | Where-Object {
          $_.payload -and $_.payload.errorCode
        }
      )
      if ($FailureEvents.Count -gt 0) {
        $Failure = $FailureEvents | Select-Object -Last 1
        $RunError = @{
          code = [string]$Failure.payload.errorCode
          message = "Workflow stopped after $([string]$Failure.type)."
          event = $Failure.payload
        }
      }
    }
  } catch {
    # The terminal Run remains authoritative. Event diagnostics are best-effort
    # and must never turn an incomplete Run into a successful result.
  }
  if (-not $RunError) {
    $RunError = @{
      code = if ($Run.status -eq "uncertain") {
        "WORKFLOW_RUN_UNCERTAIN"
      } else {
        "WORKFLOW_RUN_INCOMPLETE"
      }
      message = "Workflow ended with status $([string]$Run.status)."
    }
  }
}
$Scan = if ($Run -and $Run.output) { $Run.output.scan } else { $null }
$Complete = $Run.status -eq "succeeded" -and
  @("complete_empty", "complete_with_items") -contains $Scan.status
$Found = $Complete -and $Scan.status -eq "complete_with_items"
if (-not $RuntimeError -and -not $Complete -and -not $RunError) {
  $RunError = @{
    code = "WORKFLOW_OUTPUT_INCOMPLETE"
    message = "Workflow succeeded without a complete scan contract."
  }
}
$Status = if ($RuntimeError) {
  "runtime_error"
} elseif ($Complete) {
  if ($Found) { "clearout_found" } else { "no_clearout" }
} else {
  "incomplete"
}
$Message = if ($RuntimeError) {
  "精选联盟巡检未能启动：$RuntimeError"
} elseif ($Found) {
  "发现 $([int]$Scan.retiredProductCount) 个已清退商品，请运营及时处理。"
} elseif ($Complete) {
  "所有店铺完整扫描，未发现已清退商品。"
} else {
  switch -Regex ([string]$RunError.code) {
    "AUTH_REQUIRED|SESSION_EXPIRED" {
      "抖店登录状态已失效，请运营人工重新登录后重跑。"
      break
    }
    "CAPTCHA_REQUIRED|CHALLENGE|RISK_CONTROL" {
      "页面需要人工完成验证码或风控确认，巡检已停止。"
      break
    }
    "CONTENT_SCRIPT_MISSING|FEATURE_MISMATCH" {
      "浏览器扩展未正确注入或版本不匹配，请重载扩展并刷新抖店页面。"
      break
    }
    "BRIDGE_DISCONNECTED" {
      "BPA Browser Bridge 已断开，请恢复浏览器连接后重跑。"
      break
    }
    "SHOP_CONTEXT_RESTORE_FAILED|SHOP_IDENTITY" {
      "店铺身份或源店铺恢复无法确认，巡检已停止以避免串店。"
      break
    }
    default {
      "精选联盟巡检未形成完整结果（$([string]$RunError.code)），禁止按今日正常处理。"
    }
  }
}
$Attempt = [ordered]@{
  runId = if ($Run) { [string]$Run.id } else { $null }
  recordedAt = $RecordedAt
  businessDate = $BusinessDate
  status = $Status
  shouldNotify = $Status -ne "no_clearout"
  message = $Message
  runStatus = if ($Run) { [string]$Run.status } else { "runtime_error" }
  output = if ($Run) { $Run.output } else { $null }
  error = if ($RuntimeError) {
    @{ code = "WORKBUDDY_MONITOR_RUNTIME_ERROR"; message = $RuntimeError }
  } elseif ($RunError) {
    $RunError
  } else { $null }
}
New-Item -ItemType Directory -Path $Configuration.recordsDir -Force | Out-Null
$DailyPath = Join-Path $Configuration.recordsDir "$BusinessDate.json"
$LatestPath = Join-Path $Configuration.recordsDir "latest.json"
$Attempts = @()
if (Test-Path -LiteralPath $DailyPath -PathType Leaf) {
  $Previous = Get-Content -LiteralPath $DailyPath -Raw | ConvertFrom-Json
  if ($Previous.schemaVersion -ne 1 -or $Previous.businessDate -ne $BusinessDate) {
    throw "DAILY_STATUS_RECORD_INVALID"
  }
  $Attempts = @($Previous.attempts)
}
$Attempts = @($Attempts + $Attempt)
if ($Attempts.Count -gt 20) {
  $Attempts = @($Attempts | Select-Object -Last 20)
}
$Record = [ordered]@{
  schemaVersion = 1
  businessDate = $BusinessDate
  latestStatus = $Status
  latestRecordedAt = $RecordedAt
  attempts = $Attempts
}
$Bytes = "$($Record | ConvertTo-Json -Depth 100)`r`n"
foreach ($Destination in @($DailyPath, $LatestPath)) {
  $Temporary = "$Destination.tmp-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  [IO.File]::WriteAllText($Temporary, $Bytes, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $Temporary -Destination $Destination -Force
}
[ordered]@{
  workbuddy = @{
    shouldNotify = $Attempt.shouldNotify
    status = $Status
    message = $Message
    businessDate = $BusinessDate
  }
  record = @{ dailyPath = $DailyPath; latestPath = $LatestPath }
  attempt = $Attempt
} | ConvertTo-Json -Depth 100
if ($Status -eq "runtime_error") { exit 2 }
if ($Status -eq "incomplete") { exit 3 }
exit 0
'@
[IO.File]::WriteAllText(
  $RunnerPath,
  "$Runner`r`n",
  [Text.UTF8Encoding]::new($false)
)

if ($CapableSessions.Count -eq 0) {
  $DoctorLastError = [string](Get-OptionalProperty $Doctor.browser "lastError")
  if (
    $Doctor.browser.connected -eq $true -and
    @(
      "BROWSER_BRIDGE_FEATURE_MISMATCH",
      "BROWSER_BRIDGE_BUILD_MISMATCH"
    ) -contains $DoctorLastError
  ) {
    Write-JsonResult @{
      schemaVersion = 1
      status = "needs_extension_reload"
      runtimeIdentity = $RequiredIdentity
      errorCode = $DoctorLastError
      runtimeInstalled = $RuntimeInstalled
      assetsPublished = $false
      extensionPath = (Join-Path $InstallRoot "extension")
      requiredHumanActions = @(
        "在 Chrome 扩展页删除或重新加载旧版 BPA Browser Bridge。",
        "加载安装目录中的新版扩展：$(Join-Path $InstallRoot 'extension')",
        "刷新抖店商品管理页后重新执行验收。"
      )
    }
    exit 0
  }
  $BrowserOpened = $false
  if ($OpenBrowserSetup) {
    $BrowserOpened = Open-BrowserSetup
  }
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_native_host"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_BRIDGE_DISCONNECTED"
    runtimeInstalled = $RuntimeInstalled
    assetsPublished = $false
    extensionPath = (Join-Path $InstallRoot "extension")
    doudianLoginUrl = "https://fxg.jinritemai.com/ffa/g/list"
    browserSetupOpened = $BrowserOpened
    requiredHumanActions = @(
      "在 Chrome 扩展页开启开发者模式。",
      "加载已解压的扩展程序：$(Join-Path $InstallRoot 'extension')",
      "打开抖店商品管理页并完成登录。",
      '返回 WorkBuddy 回复"浏览器已完成"，让安装流程继续。'
    )
    resumeCommand = (
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"" +
      "$($MyInvocation.MyCommand.Path)`""
    )
  }
  exit 0
}

if ($InstanceIds.Count -gt 1 -and -not $SelectedInstanceId) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_browser_selection"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_SESSION_AMBIGUOUS"
    runtimeInstalled = $RuntimeInstalled
    assetsPublished = $false
    eligibleBrowserInstances = @(
      $InstanceIds | ForEach-Object {
        @{
          browserInstanceId = $_
        }
      }
    )
    requiredHumanActions = @(
      "让运营确认本次巡检应使用的 Chrome 浏览器实例。",
      "使用 -BrowserInstanceId <id> 重新执行安装脚本。"
    )
  }
  exit 0
}

if ($ReadyAuthenticationContexts.Count -gt 1) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_doudian_page_selection"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_PAGE_AMBIGUOUS"
    conflictingTabs = @(
      $ReadyPages | ForEach-Object {
        @{
          tabId = $_.tabId
          pathname = $_.pathname
          observedAt = $_.observedAt
        }
      }
    )
    requiredHumanActions = @(
      "存在多个店铺身份不同的抖店商品管理标签页；BPA 已拒绝猜测执行目标。",
      "只保留本次巡检要使用的商品管理标签页，或把其他商品管理标签页切换到同一店铺后刷新。",
      "无需关闭其他非抖店网页。"
    )
  }
  exit 0
}

if (-not $SelectedInstanceId -or $SelectedSessionIds.Count -eq 0) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_native_host"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_BRIDGE_DISCONNECTED"
    requiredHumanActions = @(
      "确认 Chrome 已加载 BPA Browser Bridge。",
      "确认 BPA Native Host 与 Core 正在运行。"
    )
  }
  exit 0
}

if ($SourcePages.Count -eq 0) {
  $LatestRelatedPage = $RelatedDoudianPages | Select-Object -First 1
  if ($null -ne $LatestRelatedPage -and $LatestRelatedPage.observationState -eq "challenge") {
    Write-JsonResult @{
      schemaVersion = 1
      status = "needs_human_verification"
      runtimeIdentity = $RequiredIdentity
      errorCode = "BROWSER_CHALLENGE_REQUIRED"
      requiredHumanActions = @(
        "在抖店页面人工完成验证码或风控验证。",
        "验证完成后重新打开商品管理页。"
      )
    }
    exit 0
  }
  if ($null -ne $LatestRelatedPage -and $LatestRelatedPage.observationState -eq "auth_required") {
    Write-JsonResult @{
      schemaVersion = 1
      status = "needs_doudian_login"
      runtimeIdentity = $RequiredIdentity
      errorCode = "BROWSER_AUTH_REQUIRED"
      doudianLoginUrl = "https://fxg.jinritemai.com/ffa/g/list"
      requiredHumanActions = @(
        "在抖店页面完成人工登录。",
        "登录后打开商品管理页并确认顶部显示当前店铺身份。"
      )
    }
    exit 0
  }
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_doudian_page"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_PAGE_NOT_FOUND"
    doudianLoginUrl = "https://fxg.jinritemai.com/ffa/g/list"
    requiredHumanActions = @(
      "打开抖店商品管理页。",
      "等待页面加载完成后重新执行安装验收。"
    )
  }
  exit 0
}

$LatestPage = if ($ReadyPages.Count -gt 0) {
  $ReadyPages[0]
} else {
  $SourcePages[0]
}
if (@("departed", "stale") -contains $LatestPage.observationState) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_doudian_page"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_PAGE_NOT_FOUND"
    doudianLoginUrl = "https://fxg.jinritemai.com/ffa/g/list"
    requiredHumanActions = @(
      "当前受观察的商品管理页已经关闭或离开。",
      "重新打开抖店商品管理页。"
    )
  }
  exit 0
}

if (@("loading", "probing") -contains $LatestPage.observationState) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "waiting_for_page"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_OBSERVATION_PENDING"
    requiredHumanActions = @(
      "等待抖店页面加载完成后重新执行验收。"
    )
  }
  exit 0
}

if ($LatestPage.observationState -eq "challenge") {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_human_verification"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_CHALLENGE_REQUIRED"
    requiredHumanActions = @(
      "在抖店页面人工完成验证码或风控验证。",
      "验证完成后刷新商品管理页。"
    )
  }
  exit 0
}

if (
  $LatestPage.observationState -eq "auth_required" -or
  -not (@("authenticated", "membership") -contains $LatestPage.authentication)
) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_doudian_login"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_AUTH_REQUIRED"
    requiredHumanActions = @(
      "在抖店商品管理页完成登录。",
      "确认页面顶部显示当前店铺身份。"
    )
  }
  exit 0
}

if (
  $LatestPage.observationState -eq "content_script_missing" -or
  $LatestPage.contentScriptReady -ne $true
) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_extension_reload"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_CONTENT_SCRIPT_MISSING"
    requiredHumanActions = @(
      "在 Chrome 扩展页重新加载 BPA Browser Bridge。",
      "刷新抖店商品管理页。"
    )
  }
  exit 0
}

if ($ReadyPages.Count -eq 0) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "waiting_for_page"
    runtimeIdentity = $RequiredIdentity
    errorCode = "BROWSER_OBSERVATION_PENDING"
    requiredHumanActions = @(
      "等待抖店页面加载完成后重新执行验收。"
    )
  }
  exit 0
}

foreach ($Asset in $RequiredAssets) {
  $AssetPath = Join-Path $WorkflowAssetsRoot $Asset.file
  Invoke-Bpa `
    $BpaCommand `
    @("validate", $Asset.type, $AssetPath) `
    "Validate $($Asset.type)" | Out-Null
}
foreach ($Asset in $RequiredAssets) {
  $AssetPath = Join-Path $WorkflowAssetsRoot $Asset.file
  Invoke-Bpa `
    $BpaCommand `
    @("publish", $Asset.type, $AssetPath, "--yes") `
    "Publish $($Asset.type)" | Out-Null
}

$SmokeText = & powershell.exe `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File $RunnerPath `
  -ConfigurationPath $ConfigurationPath
$Smoke = $SmokeText | ConvertFrom-Json
if (-not $Smoke.record.dailyPath) {
  throw "The read-only browser smoke test did not persist a daily record."
}
$SmokeSucceeded =
  @("no_clearout", "clearout_found") -contains $Smoke.workbuddy.status -and
  $Smoke.attempt.runStatus -eq "succeeded" -and
  @("complete_empty", "complete_with_items") -contains `
    $Smoke.attempt.output.scan.status
if ($SmokeSucceeded) {
  try {
    if (-not (Test-Path -LiteralPath $Smoke.record.dailyPath -PathType Leaf)) {
      throw "DAILY_STATUS_RECORD_MISSING"
    }
    $PersistedSmoke = Get-Content `
      -LiteralPath $Smoke.record.dailyPath `
      -Raw | ConvertFrom-Json
    $PersistedAttempts = @($PersistedSmoke.attempts)
    if (
      $PersistedSmoke.schemaVersion -ne 1 -or
      $PersistedSmoke.businessDate -ne $Smoke.workbuddy.businessDate -or
      $PersistedSmoke.latestStatus -ne $Smoke.workbuddy.status -or
      $PersistedAttempts.Count -eq 0
    ) {
      throw "DAILY_STATUS_RECORD_INVALID"
    }
    $PersistedAttempt = $PersistedAttempts | Select-Object -Last 1
    if (
      $PersistedAttempt.runId -ne $Smoke.attempt.runId -or
      $PersistedAttempt.runStatus -ne "succeeded" -or
      $PersistedAttempt.status -ne $Smoke.workbuddy.status -or
      -not (@("complete_empty", "complete_with_items") -contains `
        $PersistedAttempt.output.scan.status)
    ) {
      throw "DAILY_STATUS_RECORD_RUN_MISMATCH"
    }
    $DiscoveredShopCount = [int]$PersistedAttempt.output.scan.discoveredShopCount
    $ScannedShopCount = [int]$PersistedAttempt.output.scan.scannedShopCount
    $FailedShopCount = [int]$PersistedAttempt.output.scan.failedShopCount
    if (
      $DiscoveredShopCount -lt 1 -or
      $ScannedShopCount -ne $DiscoveredShopCount -or
      $FailedShopCount -ne 0
    ) {
      throw "DAILY_STATUS_RECORD_INCOMPLETE_SHOPS"
    }
  } catch {
    $SmokeSucceeded = $false
    if (-not $Smoke.attempt.error) {
      $Smoke.attempt.error = @{
        code = "LIVE_ACCEPTANCE_RECORD_INVALID"
        message = $_.Exception.Message
      }
    }
  }
}
if (-not $SmokeSucceeded) {
  $SmokeErrorCode = [string]$Smoke.attempt.error.code
  if (-not $SmokeErrorCode) {
    $SmokeErrorCode = "WORKFLOW_SMOKE_TEST_INCOMPLETE"
  }
  Write-JsonResult @{
    schemaVersion = 1
    status = "smoke_test_failed"
    runtimeIdentity = $RequiredIdentity
    errorCode = $SmokeErrorCode
    dailyPath = $Smoke.record.dailyPath
    smokeTestStatus = $Smoke.workbuddy.status
    requiredHumanActions = @(
      "打开 dailyPath 对应记录查看准确失败原因。",
      "按错误码恢复浏览器登录、验证码、扩展或页面后重新执行安装验收。"
    )
  }
  exit 0
}

$DeploymentFiles = @(
  @{ Staged = $AutomationPromptTarget; Final = $AutomationPromptFinal },
  @{ Staged = $ConfigurationPath; Final = $ConfigurationFinal },
  @{ Staged = $RunnerPath; Final = $RunnerFinal }
)
$DeploymentBackups = @()
try {
  foreach ($DeploymentFile in $DeploymentFiles) {
    $Backup = Join-Path `
      $DeploymentStage `
      "backup-$([Guid]::NewGuid().ToString('N'))"
    $HadOriginal = Test-Path -LiteralPath $DeploymentFile.Final -PathType Leaf
    if ($HadOriginal) {
      Copy-Item -LiteralPath $DeploymentFile.Final -Destination $Backup
    }
    $DeploymentBackups += @{
      Final = $DeploymentFile.Final
      Backup = $Backup
      HadOriginal = $HadOriginal
    }
    $Next = "$($DeploymentFile.Final).next-$PID"
    Copy-Item -LiteralPath $DeploymentFile.Staged -Destination $Next -Force
    Move-Item -LiteralPath $Next -Destination $DeploymentFile.Final -Force
  }
} catch {
  foreach ($DeploymentBackup in $DeploymentBackups) {
    if ($DeploymentBackup.HadOriginal) {
      Copy-Item `
        -LiteralPath $DeploymentBackup.Backup `
        -Destination $DeploymentBackup.Final `
        -Force
    } elseif (Test-Path -LiteralPath $DeploymentBackup.Final) {
      Remove-Item -LiteralPath $DeploymentBackup.Final -Force
    }
  }
  throw
}

Write-JsonResult @{
  schemaVersion = 1
  status = "ready"
  runtimeInstalled = $RuntimeInstalled
  assetsPublished = $true
  runtimeIdentity = $RequiredIdentity
  browserInstanceId = $SelectedInstanceId
  sourceTab = @{
    tabId = $ReadyPages[0].tabId
    origin = $ReadyPages[0].origin
    pathname = $ReadyPages[0].pathname
    authenticationContextRef = $ReadyPages[0].authenticationContextRef
  }
  smokeTest = @{
    status = $Smoke.workbuddy.status
    dailyPath = $Smoke.record.dailyPath
  }
  acceptance = @{
    businessDate = $PersistedSmoke.businessDate
    runId = $PersistedAttempt.runId
    discoveredShopCount = $DiscoveredShopCount
    scannedShopCount = $ScannedShopCount
    failedShopCount = $FailedShopCount
    recordVerified = $true
  }
  configurationPath = $ConfigurationFinal
  runnerPath = $RunnerFinal
  recordsDir = $RecordsRoot
  automation = @{
    name = "抖店精选联盟清退商品日巡检"
    schedule = "每天 13:00"
    timezone = "Asia/Shanghai"
    skill = "抖店联盟清退巡检"
    promptPath = $AutomationPromptFinal
    pushToWorkBuddy = $true
  }
}
