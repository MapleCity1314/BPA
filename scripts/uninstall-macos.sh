#!/bin/zsh
set -euo pipefail

USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
RUNTIME_ROOT="$BPA_ROOT/runtime"
CURRENT_LINK="$RUNTIME_ROOT/current"
CORE_LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.core.plist"
CHROME_LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.inventory-chrome.plist"
HOST_MANIFEST="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bpa.browser.json"
LOG_ROOT="$USER_HOME/Library/Logs/BPA"
INSTALL_LOCK="$BPA_ROOT/run/runtime-install.lock"
MAINTENANCE_LOCK="$BPA_ROOT/run/runtime-maintenance.lock"
PURGE_DATA=false
if [[ "${1:-}" == "--purge-data" ]]; then
  PURGE_DATA=true
elif [[ $# -gt 0 ]]; then
  print -u2 "Usage: $0 [--purge-data]"
  exit 1
fi

if [[ ! -L "$CURRENT_LINK" ]]; then
  print -u2 "A verified current BPA Runtime is required for safe uninstall."
  exit 1
fi
CURRENT_VERSION="$(readlink "$CURRENT_LINK")"
CURRENT_ROOT="$RUNTIME_ROOT/$CURRENT_VERSION"
for required in \
  "$CURRENT_ROOT/node/bin/node" \
  "$CURRENT_ROOT/bin/bpa" \
  "$CURRENT_ROOT/bin/bpa-core-identity.js" \
  "$CURRENT_ROOT/bin/bpa-managed-chrome-agent.js"; do
  if [[ ! -f "$required" ]]; then
    print -u2 "Safe uninstall closure file is unavailable: $required"
    exit 1
  fi
done
if [[ ! -f "$CORE_LAUNCH_AGENT" || ! -f "$CHROME_LAUNCH_AGENT" ]]; then
  print -u2 "Safe uninstall requires Core and managed Chrome Launch Agents."
  exit 1
fi
if ! mkdir "$INSTALL_LOCK" 2>/dev/null; then
  print -u2 "Another BPA Runtime installation is active."
  exit 1
fi
if ! mkdir "$MAINTENANCE_LOCK" 2>/dev/null; then
  rmdir "$INSTALL_LOCK"
  print -u2 "BPA Runtime maintenance is already active."
  exit 1
fi
MAINTENANCE_RESULT="$BPA_ROOT/.uninstall-maintenance.$$.json"
CORE_STOPPED=false
CHROME_STOPPED=false
REMOVAL_STARTED=false
cleanup_locks() {
  [[ -f "$MAINTENANCE_RESULT" ]] && rm "$MAINTENANCE_RESULT"
  rmdir "$MAINTENANCE_LOCK" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || true
}
restore_before_removal() {
  local exit_code=$?
  if ! $REMOVAL_STARTED; then
    if $CORE_STOPPED; then
      launchctl bootstrap "gui/$(id -u)" "$CORE_LAUNCH_AGENT" 2>/dev/null || true
    fi
    if $CHROME_STOPPED; then
      launchctl bootstrap "gui/$(id -u)" "$CHROME_LAUNCH_AGENT" 2>/dev/null || true
    fi
  fi
  cleanup_locks
  exit $exit_code
}
trap restore_before_removal EXIT

CORE_PID="$(
  launchctl print "gui/$(id -u)/com.bpa.core" 2>/dev/null |
    awk '/pid =/{print $3; exit}' || true
)"
CHROME_PID="$(
  launchctl print "gui/$(id -u)/com.bpa.inventory-chrome" 2>/dev/null |
    awk '/pid =/{print $3; exit}' || true
)"
if [[ -z "$CORE_PID" || -z "$CHROME_PID" ]]; then
  print -u2 "Safe uninstall requires the verified Core and managed Chrome to be running."
  exit 1
fi
"$CURRENT_ROOT/node/bin/node" \
  "$CURRENT_ROOT/bin/bpa-core-identity.js" \
  --lock "$BPA_ROOT/run/core.lock" \
  --pid "$CORE_PID" \
  --identity "$CURRENT_VERSION" \
  --executable "$CURRENT_ROOT/node/bin/node" \
  --entrypoint "$CURRENT_ROOT/bin/bpa-core.js" >/dev/null
"$CURRENT_ROOT/node/bin/node" \
  "$CURRENT_ROOT/bin/bpa-managed-chrome-agent.js" \
  chrome-verify \
  --manifest "$CURRENT_ROOT/runtime-manifest.json" \
  --path "$CHROME_LAUNCH_AGENT" \
  --bpa-home "$BPA_ROOT" \
  --runtime-root "$RUNTIME_ROOT" \
  --log-root "$LOG_ROOT" \
  --pid "$CHROME_PID" >/dev/null

MAINTENANCE_READY=false
for _attempt in {1..300}; do
  if ! BPA_HOME="$BPA_ROOT" \
    "$CURRENT_ROOT/bin/bpa" runtime maintenance-status \
    > "$MAINTENANCE_RESULT"; then
    print -u2 "The running BPA Core does not support the maintenance readiness protocol."
    exit 1
  fi
  MAINTENANCE_STATE="$(
    "$CURRENT_ROOT/node/bin/node" \
      "$CURRENT_ROOT/bin/bpa-managed-chrome-agent.js" \
      maintenance "$MAINTENANCE_RESULT"
  )"
  if [[ "$MAINTENANCE_STATE" == "ready" ]]; then
    MAINTENANCE_READY=true
    break
  fi
  sleep 0.2
done
if ! $MAINTENANCE_READY; then
  print -u2 "BPA Runtime effects did not drain before the uninstall deadline."
  exit 1
fi

CHROME_STOPPED=true
launchctl bootout "gui/$(id -u)/com.bpa.inventory-chrome"
CORE_STOPPED=true
launchctl bootout "gui/$(id -u)/com.bpa.core"
REMOVAL_STARTED=true
rm "$CHROME_LAUNCH_AGENT"
rm "$CORE_LAUNCH_AGENT"
[[ -f "$HOST_MANIFEST" ]] && rm "$HOST_MANIFEST"
[[ -d "$RUNTIME_ROOT" ]] && rm -rf "$RUNTIME_ROOT"
[[ -d "$BPA_ROOT/extension" ]] && rm -rf "$BPA_ROOT/extension"
[[ -S "$BPA_ROOT/run/core.sock" ]] && rm "$BPA_ROOT/run/core.sock"

if $PURGE_DATA; then
  [[ -d "$BPA_ROOT/data" ]] && rm -rf "$BPA_ROOT/data"
  print "BPA runtime, managed Chrome control, and business data removed."
else
  print "BPA runtime and managed Chrome control removed. Business data remains in $BPA_ROOT/data"
fi
cleanup_locks
trap - EXIT
