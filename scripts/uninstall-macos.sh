#!/bin/zsh
set -euo pipefail

USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.core.plist"
HOST_MANIFEST="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bpa.browser.json"
PURGE_DATA=false
if [[ "${1:-}" == "--purge-data" ]]; then
  PURGE_DATA=true
elif [[ $# -gt 0 ]]; then
  print -u2 "Usage: $0 [--purge-data]"
  exit 1
fi

launchctl bootout "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
[[ -f "$LAUNCH_AGENT" ]] && rm "$LAUNCH_AGENT"
[[ -f "$HOST_MANIFEST" ]] && rm "$HOST_MANIFEST"
[[ -d "$BPA_ROOT/runtime" ]] && rm -rf "$BPA_ROOT/runtime"
[[ -S "$BPA_ROOT/run/core.sock" ]] && rm "$BPA_ROOT/run/core.sock"

if $PURGE_DATA; then
  [[ -d "$BPA_ROOT/data" ]] && rm -rf "$BPA_ROOT/data"
  print "BPA runtime and business data removed."
else
  print "BPA runtime removed. Business data remains in $BPA_ROOT/data"
fi
