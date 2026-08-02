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
  [switch]$OpenBrowserSetup,
  [switch]$ValidatePackageOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-JsonResult([hashtable]$Value) {
  $Value | ConvertTo-Json -Depth 8
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

$RequiredAssets = @(
  @{
    type = "node"
    file = "doudian.alliance.shops.discover.node.yaml"
    sha256 = "6683915f4b31f57b01dfb866d06a30fed714ac37924502bdb6e34db2f38a1f92"
  },
  @{
    type = "node"
    file = "doudian.alliance.shop.retired-products.scan.node.yaml"
    sha256 = "4865d046a6496dd07a1285e20bb580fdf64d53759b8b015bb335cdc001aefd20"
  },
  @{
    type = "node"
    file = "doudian.alliance.retired-products.aggregate.node.yaml"
    sha256 = "3828a3519fce367625c882b24eb26db1c4062c5ae907cdbc603a1014333967ef"
  },
  @{
    type = "adapter"
    file = "doudian-alliance.adapter.yaml"
    sha256 = "295dc30c53620d8f0a0503780a59edcb16ca138c93a14da6306940d48df5df02"
  },
  @{
    type = "workflow"
    file = "doudian.alliance-retired-products-monitor.workflow.yaml"
    sha256 = "97d22c6ad687c2c3716402f8a4d0cd02652d53fb12d6676ff1882ccf4b71318e"
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
  if ($CurrentIdentity -ne $RequiredIdentity) {
    & (Join-Path $PackageRoot "install.ps1") -InstallRoot $InstallRoot
    if ($LASTEXITCODE -ne 0) {
      throw "The BPA Runtime installer exited with code $LASTEXITCODE."
    }
    $RuntimeInstalled = $true
  }
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

foreach ($Asset in $RequiredAssets) {
  $AssetPath = Join-Path $WorkflowAssetsRoot $Asset.file
  Invoke-Bpa `
    $BpaCommand `
    @("validate", $Asset.type, $AssetPath) `
    "Validate $($Asset.type)" | Out-Null
  Invoke-Bpa `
    $BpaCommand `
    @("publish", $Asset.type, $AssetPath, "--yes") `
    "Publish $($Asset.type)" | Out-Null
}

New-Item -ItemType Directory -Path $RecordsRoot -Force | Out-Null
$WorkBuddyRoot = Join-Path $InstallRoot "workbuddy"
New-Item -ItemType Directory -Path $WorkBuddyRoot -Force | Out-Null
$AutomationPromptSource = Join-Path `
  $SkillRoot `
  "references\workbuddy-automation-prompt.md"
$AutomationPromptDigest = (
  Get-FileHash -LiteralPath $AutomationPromptSource -Algorithm SHA256
).Hash.ToLowerInvariant()
if (
  $AutomationPromptDigest -ne
    "5b73424c0e2ccebf828a18c3b0232c7f7ac76f71a969bc55816f8e64280e33d9"
) {
  throw "The WorkBuddy automation prompt failed SHA-256 verification."
}
$AutomationPromptTarget = Join-Path `
  $WorkBuddyRoot `
  "workbuddy-automation-prompt.md"
Copy-Item `
  -LiteralPath $AutomationPromptSource `
  -Destination $AutomationPromptTarget `
  -Force

$SessionsText = Invoke-Bpa `
  $BpaCommand `
  @("browser-sessions", "--limit", "100") `
  "Read browser sessions"
$Sessions = @($SessionsText | ConvertFrom-Json)
$CapableSessions = @(
  $Sessions | Where-Object {
    -not $_.disconnectedAt -and $_.capabilityDigest -and
    @($_.capabilities | Where-Object {
      $_.nodeId -eq "doudian.alliance.shops.discover" -and
      $_.nodeVersion -eq "1.0.0"
    }).Count -gt 0
  }
)
$PagesText = Invoke-Bpa `
  $BpaCommand `
  @("browser-pages", "--limit", "200") `
  "Read browser page observations"
$Pages = @($PagesText | ConvertFrom-Json)
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
    $_.authenticationContextRef
  }
)

$ConfigurationPath = Join-Path `
  $WorkBuddyRoot `
  "doudian-alliance-retired-monitor.json"
$Configuration = [ordered]@{
  schemaVersion = 1
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  runtimeIdentity = $RequiredIdentity
  bpaCommand = $BpaCommand
  recordsDir = $RecordsRoot
  workflow = "doudian.alliance-retired-products-monitor@2.0.0"
  maxShops = 100
  schedule = "daily 13:00"
  timezone = "Asia/Shanghai"
  browserInstanceId = $SelectedInstanceId
}
[IO.File]::WriteAllText(
  $ConfigurationPath,
  "$($Configuration | ConvertTo-Json -Depth 5)`r`n",
  [Text.UTF8Encoding]::new($false)
)

$RunnerPath = Join-Path $WorkBuddyRoot "Run-DoudianAllianceMonitor.ps1"
$Runner = @'
[CmdletBinding()]
param([int]$MaxShops = 0)
$ErrorActionPreference = "Stop"
$ConfigurationPath = Join-Path $env:LOCALAPPDATA "BPA\workbuddy\doudian-alliance-retired-monitor.json"
$Configuration = Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json
$EffectiveMaxShops = if ($MaxShops -gt 0) {
  $MaxShops
} else {
  [int]$Configuration.maxShops
}
$Arguments = @(
  "workflow-run",
  "doudian.alliance-retired-products-monitor",
  "--version", "2.0.0",
  "--input", "{`"maxShops`":$EffectiveMaxShops}",
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
try {
  $RunText = & ([string]$Configuration.bpaCommand) @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($RunText -join "`n")
  }
  $Run = ($RunText -join "`n") | ConvertFrom-Json
} catch {
  $RuntimeError = $_.Exception.Message
}
$Scan = if ($Run -and $Run.output) { $Run.output.scan } else { $null }
$Complete = $Run.status -eq "succeeded" -and
  @("complete_empty", "complete_with_items") -contains $Scan.status
$Found = $Complete -and $Scan.status -eq "complete_with_items"
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
  "精选联盟巡检未形成完整结果，禁止按今日正常处理。"
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
exit 0
'@
[IO.File]::WriteAllText(
  $RunnerPath,
  "$Runner`r`n",
  [Text.UTF8Encoding]::new($false)
)

if ($CapableSessions.Count -eq 0) {
  if (
    $Doctor.browser.connected -eq $true -and
    [string]$Doctor.browser.lastError -eq
      "BROWSER_BRIDGE_FEATURE_MISMATCH"
  ) {
    Write-JsonResult @{
      schemaVersion = 1
      status = "needs_extension_reload"
      errorCode = "BROWSER_BRIDGE_FEATURE_MISMATCH"
      runtimeInstalled = $RuntimeInstalled
      assetsPublished = $true
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
    errorCode = "BROWSER_BRIDGE_DISCONNECTED"
    runtimeInstalled = $RuntimeInstalled
    assetsPublished = $true
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
    errorCode = "BROWSER_SESSION_AMBIGUOUS"
    runtimeInstalled = $RuntimeInstalled
    assetsPublished = $true
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

if (-not $SelectedInstanceId -or $SelectedSessionIds.Count -eq 0) {
  Write-JsonResult @{
    schemaVersion = 1
    status = "needs_native_host"
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
  if ($LatestRelatedPage.observationState -eq "challenge") {
    Write-JsonResult @{
      schemaVersion = 1
      status = "needs_human_verification"
      errorCode = "BROWSER_CHALLENGE_REQUIRED"
      requiredHumanActions = @(
        "在抖店页面人工完成验证码或风控验证。",
        "验证完成后重新打开商品管理页。"
      )
    }
    exit 0
  }
  if ($LatestRelatedPage.observationState -eq "auth_required") {
    Write-JsonResult @{
      schemaVersion = 1
      status = "needs_doudian_login"
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
    errorCode = "BROWSER_OBSERVATION_PENDING"
    requiredHumanActions = @(
      "等待抖店页面加载完成后重新执行验收。"
    )
  }
  exit 0
}

$SmokeText = & powershell.exe `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File $RunnerPath
$Smoke = $SmokeText | ConvertFrom-Json
if (-not $Smoke.record.dailyPath) {
  throw "The read-only browser smoke test did not persist a daily record."
}
$SmokeSucceeded =
  @("no_clearout", "clearout_found") -contains $Smoke.workbuddy.status -and
  $Smoke.attempt.runStatus -eq "succeeded" -and
  @("complete_empty", "complete_with_items") -contains `
    $Smoke.attempt.output.scan.status
if (-not $SmokeSucceeded) {
  $SmokeErrorCode = [string]$Smoke.attempt.error.code
  if (-not $SmokeErrorCode) {
    $SmokeErrorCode = "WORKFLOW_SMOKE_TEST_INCOMPLETE"
  }
  Write-JsonResult @{
    schemaVersion = 1
    status = "smoke_test_failed"
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
  configurationPath = $ConfigurationPath
  runnerPath = $RunnerPath
  recordsDir = $RecordsRoot
  automation = @{
    name = "抖店精选联盟清退商品日巡检"
    schedule = "每天 13:00"
    timezone = "Asia/Shanghai"
    skill = "抖店联盟清退巡检"
    promptPath = $AutomationPromptTarget
    pushToWorkBuddy = $true
  }
}
