import { resolve } from "node:path";

export const MACOS_MANAGED_CHROME_CONTRACT = Object.freeze({
  schema: "bpa.managed-chrome/2",
  launchAgentLabel: "com.bpa.inventory-chrome",
  interactionMode: "background-extension-only",
  windowMode: "launchservices-hidden",
  applicationRelativePath: "browser/Google Chrome for Testing.app",
  browserSourceEnvironment: "BPA_CHROME_FOR_TESTING_APP",
  bundleIdentifier: "com.google.chrome.for.testing",
  executablePath:
    "browser/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  profileRelativePath: "chrome-inventory-profile",
  extensionRelativePath: "extension",
  remoteDebuggingAddress: "127.0.0.1",
  remoteDebuggingPort: 17660,
  flags: Object.freeze([
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--restore-last-session",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"
  ])
});

const activityKeys = [
  "activeRunCount",
  "activeTriggerOccurrenceCount",
  "activeTriggerAttemptCount",
  "pendingEngineOutboxCount",
  "activeControlLeaseCount",
  "activeExternalDomainLeaseCount",
  "activeStagingLeaseCount",
  "activeRecoverySessionCount",
  "activeAttentionDeliveryCount",
  "terminalRunCount",
  "latestTerminalRunAt"
];
const browserKeys = [
  "pendingCancelRequestCount",
  "pendingQueueCount",
  "activePageProbeCount",
  "activeExtensionCommandCount",
  "activeExtensionStageCount",
  "activeExtensionCancellationCount",
  "activeManagedTabReservationCount",
  "activePacingReservationCount",
  "activeExtensionProbeCount"
];
const blockerCodes = new Set([
  "MAINTENANCE_LOCK_NOT_HELD",
  "ACTIVE_RUNS",
  "ACTIVE_TRIGGER_ATTEMPTS",
  "PENDING_ENGINE_OUTBOX",
  "ACTIVE_CONTROL_LEASES",
  "ACTIVE_EXTERNAL_DOMAIN_LEASES",
  "ACTIVE_STAGING_LEASES",
  "ACTIVE_RECOVERY_SESSIONS",
  "ACTIVE_ATTENTION_DELIVERIES",
  "CONTROL_MUTATIONS_ACTIVE",
  "BROWSER_COMMANDS_ACTIVE",
  "TEAM_INVOCATIONS_ACTIVE"
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${name} fields are invalid`);
  }
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function absolutePath(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    resolve(value) !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${name} must be an absolute single-line path`);
  }
  return value;
}

export function assertRuntimeMaintenanceReadiness(value) {
  exactKeys(
    value,
    [
      "schema",
      "observedAt",
      "maintenanceActive",
      "ready",
      "blockers",
      "activity",
      "browser",
      "delivery",
      "control",
      "teamWorker"
    ],
    "Runtime maintenance status"
  );
  if (
    value.schema !== "bpa.runtime-maintenance-readiness/1" ||
    Number.isNaN(Date.parse(value.observedAt)) ||
    value.maintenanceActive !== true ||
    typeof value.ready !== "boolean" ||
    !Array.isArray(value.blockers)
  ) {
    throw new Error("Runtime maintenance identity is invalid");
  }
  const uniqueBlockers = new Set(value.blockers);
  if (
    uniqueBlockers.size !== value.blockers.length ||
    value.blockers.some((code) => !blockerCodes.has(code)) ||
    value.ready !== (value.blockers.length === 0)
  ) {
    throw new Error("Runtime maintenance blockers are invalid");
  }
  exactKeys(value.activity, activityKeys, "Runtime activity");
  for (const key of activityKeys.filter((key) => key !== "latestTerminalRunAt")) {
    nonnegativeInteger(value.activity[key], `Runtime activity ${key}`);
  }
  if (
    value.activity.latestTerminalRunAt !== null &&
    Number.isNaN(Date.parse(value.activity.latestTerminalRunAt))
  ) {
    throw new Error("Runtime latest terminal timestamp is invalid");
  }
  exactKeys(value.browser, browserKeys, "Browser activity");
  for (const key of browserKeys) {
    nonnegativeInteger(value.browser[key], `Browser activity ${key}`);
  }
  exactKeys(value.delivery, ["inFlight"], "Attention delivery activity");
  if (typeof value.delivery.inFlight !== "boolean") {
    throw new Error("Attention delivery activity is invalid");
  }
  exactKeys(value.control, ["inFlightMutationCount"], "Control activity");
  nonnegativeInteger(
    value.control.inFlightMutationCount,
    "Control in-flight mutation count"
  );
  exactKeys(
    value.teamWorker,
    ["state", "pendingInvocationCount"],
    "Team Worker activity"
  );
  if (
    !["stopped", "starting", "ready", "unavailable"].includes(
      value.teamWorker.state
    )
  ) {
    throw new Error("Team Worker state is invalid");
  }
  nonnegativeInteger(
    value.teamWorker.pendingInvocationCount,
    "Team Worker pending invocation count"
  );
  const expectedBlockers = [];
  for (const [count, code] of [
    [value.activity.activeRunCount, "ACTIVE_RUNS"],
    [value.activity.activeTriggerAttemptCount, "ACTIVE_TRIGGER_ATTEMPTS"],
    [value.activity.pendingEngineOutboxCount, "PENDING_ENGINE_OUTBOX"],
    [value.activity.activeControlLeaseCount, "ACTIVE_CONTROL_LEASES"],
    [
      value.activity.activeExternalDomainLeaseCount,
      "ACTIVE_EXTERNAL_DOMAIN_LEASES"
    ],
    [value.activity.activeStagingLeaseCount, "ACTIVE_STAGING_LEASES"],
    [value.activity.activeRecoverySessionCount, "ACTIVE_RECOVERY_SESSIONS"]
  ]) {
    if (count > 0) expectedBlockers.push(code);
  }
  if (browserKeys.some((key) => value.browser[key] > 0)) {
    expectedBlockers.push("BROWSER_COMMANDS_ACTIVE");
  }
  if (value.delivery.inFlight) {
    expectedBlockers.push("ACTIVE_ATTENTION_DELIVERIES");
  }
  if (value.control.inFlightMutationCount > 0) {
    expectedBlockers.push("CONTROL_MUTATIONS_ACTIVE");
  }
  if (value.teamWorker.pendingInvocationCount > 0) {
    expectedBlockers.push("TEAM_INVOCATIONS_ACTIVE");
  }
  if (JSON.stringify(value.blockers) !== JSON.stringify(expectedBlockers)) {
    throw new Error("Runtime maintenance blockers do not match live activity");
  }
  return value;
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderManagedChromeLaunchAgent(input) {
  const bpaHome = absolutePath(input.bpaHome, "BPA home");
  const runtimeRoot = absolutePath(input.runtimeRoot, "Runtime root");
  const logRoot = absolutePath(input.logRoot, "Log root");
  const launcher = `${runtimeRoot}/current/bin/bpa-managed-chrome`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MACOS_MANAGED_CHROME_CONTRACT.launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(launcher)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(`${logRoot}/managed-chrome.stdout.log`)}</string>
  <key>StandardErrorPath</key><string>${xml(`${logRoot}/managed-chrome.stderr.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>BPA_HOME</key><string>${xml(bpaHome)}</string></dict>
</dict>
</plist>
`;
}

export function renderManagedChromeLauncher(releaseIdentity) {
  if (typeof releaseIdentity !== "string" || releaseIdentity.length === 0) {
    throw new Error("Managed Chrome launcher requires a release identity");
  }
  const contract = MACOS_MANAGED_CHROME_CONTRACT;
  const staticArguments = contract.flags
    .map((flag, index) =>
      index === contract.flags.length - 1 ? `  "${flag}"` : `  "${flag}" \\`
    )
    .join("\n");
  return `#!/bin/zsh
set -euo pipefail
if [[ -z "\${BPA_HOME:-}" ]]; then
  print -u2 "BPA_HOME is required to start managed Chrome."
  exit 1
fi
APP="$BPA_HOME/${contract.applicationRelativePath}"
CHROME="$BPA_HOME/${contract.executablePath}"
PROFILE="$BPA_HOME/${contract.profileRelativePath}"
EXTENSION="$BPA_HOME/${contract.extensionRelativePath}"
if [[ ! -x "$CHROME" ]]; then
  print -u2 "Managed Chrome executable is unavailable."
  exit 1
fi
if [[ ! -f "$EXTENSION/manifest.json" ]]; then
  print -u2 "Managed Chrome Browser Bridge is unavailable."
  exit 1
fi
IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
if [[ "$IDENTIFIER" != "${contract.bundleIdentifier}" ]]; then
  print -u2 "Managed Chrome application identity is invalid."
  exit 1
fi
mkdir -p "$PROFILE"
chmod 700 "$PROFILE"
export BPA_RUNTIME_ID=${JSON.stringify(releaseIdentity)}
find_managed_chrome_pid() {
  /bin/ps -axo pid=,command= | /usr/bin/awk \
    -v executable="$CHROME" \
    -v profile="--user-data-dir=$PROFILE" '
      !found && index($0, executable " ") && index($0, profile) && !index($0, " --type=") {
        print $1
        found = 1
      }
    '
}
stop_managed_chrome() {
  local managed_pid="$(find_managed_chrome_pid)"
  if [[ -n "$managed_pid" ]]; then
    /bin/kill -TERM "$managed_pid" 2>/dev/null || true
  fi
  exit 0
}
trap stop_managed_chrome TERM INT HUP
MANAGED_PID="$(find_managed_chrome_pid)"
if [[ -z "$MANAGED_PID" ]]; then
  "$CHROME" \\
  "--user-data-dir=$PROFILE" \\
  "--remote-debugging-port=${contract.remoteDebuggingPort}" \\
  "--remote-debugging-address=${contract.remoteDebuggingAddress}" \\
${staticArguments}
  "--disable-extensions-except=$EXTENSION" \\
  "--load-extension=$EXTENSION" >/dev/null 2>&1 &
  for _attempt in {1..150}; do
    MANAGED_PID="$(find_managed_chrome_pid)"
    [[ -n "$MANAGED_PID" ]] && break
    /bin/sleep 0.2
  done
fi
if [[ -z "$MANAGED_PID" ]]; then
  print -u2 "Managed Chrome did not start in the background."
  exit 1
fi
while /bin/kill -0 "$MANAGED_PID" 2>/dev/null; do
  /bin/sleep 5
done
`;
}

export function assertManagedChromeManifest(manifest) {
  exactKeys(
    manifest,
    [
      "schema",
      "launchAgentLabel",
      "interactionMode",
      "windowMode",
      "applicationRelativePath",
      "browserSourceEnvironment",
      "bundleIdentifier",
      "executablePath",
      "profileRelativePath",
      "extensionRelativePath",
      "remoteDebuggingAddress",
      "remoteDebuggingPort",
      "flags"
    ],
    "Managed Chrome manifest"
  );
  if (JSON.stringify(manifest) !== JSON.stringify(MACOS_MANAGED_CHROME_CONTRACT)) {
    throw new Error("Managed Chrome manifest differs from the Runtime contract");
  }
  return manifest;
}

export function assertManagedChromeProcessCommand(command, bpaHome) {
  const root = absolutePath(bpaHome, "BPA home");
  const contract = MACOS_MANAGED_CHROME_CONTRACT;
  if (typeof command !== "string") {
    throw new Error("Live managed Chrome command differs from the Runtime closure");
  }
  const required = [
    `${root}/${contract.executablePath}`,
    `--user-data-dir=${root}/${contract.profileRelativePath}`,
    `--remote-debugging-port=${contract.remoteDebuggingPort}`,
    `--remote-debugging-address=${contract.remoteDebuggingAddress}`,
    ...contract.flags
  ];
  const containsArgument = (part) => {
    let offset = command.indexOf(part);
    while (offset >= 0) {
      const before = offset === 0 ? "" : command[offset - 1];
      const after = command[offset + part.length] ?? "";
      if (
        (before === "" || /[\s"']/u.test(before)) &&
        (after === "" || /[\s"']/u.test(after))
      ) {
        return true;
      }
      offset = command.indexOf(part, offset + 1);
    }
    return false;
  };
  if (
    required.some((part) => !containsArgument(part))
  ) {
    throw new Error("Live managed Chrome command differs from the Runtime closure");
  }
}

export function assertManagedChromeSupervisorCommand(command, runtimeRoot) {
  const root = absolutePath(runtimeRoot, "Runtime root");
  const launcher = `${root}/current/bin/bpa-managed-chrome`;
  const offset = typeof command === "string" ? command.indexOf(launcher) : -1;
  const before = offset <= 0 ? "" : command[offset - 1];
  const after = offset < 0 ? "" : command[offset + launcher.length] ?? "";
  if (
    offset < 0 ||
    (before !== "" && !/[\s"']/u.test(before)) ||
    (after !== "" && !/[\s"']/u.test(after))
  ) {
    throw new Error(
      "Live managed Chrome supervisor differs from the Runtime closure"
    );
  }
  return command;
}
