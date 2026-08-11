#!/bin/zsh
set -euo pipefail

USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
RUNTIME_ROOT="$BPA_ROOT/runtime"
DATA_DB="$BPA_ROOT/data/bpa.sqlite"
PREVIOUS_LINK="$RUNTIME_ROOT/previous"
CURRENT_LINK="$RUNTIME_ROOT/current"
EXTENSION_ROOT="$BPA_ROOT/extension"
CORE_LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.core.plist"
CHROME_LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.inventory-chrome.plist"
LOG_ROOT="$USER_HOME/Library/Logs/BPA"
INSTALL_LOCK="$BPA_ROOT/run/runtime-install.lock"
MAINTENANCE_LOCK="$BPA_ROOT/run/runtime-maintenance.lock"

if [[ ! -L "$PREVIOUS_LINK" || ! -L "$CURRENT_LINK" ]]; then
  print -u2 "Both current and previous BPA runtimes are required."
  exit 1
fi

TARGET_VERSION="$(readlink "$PREVIOUS_LINK")"
CURRENT_VERSION="$(readlink "$CURRENT_LINK")"
TARGET_ROOT="$RUNTIME_ROOT/$TARGET_VERSION"
CURRENT_ROOT="$RUNTIME_ROOT/$CURRENT_VERSION"
TARGET_EXTENSION="$TARGET_ROOT/extension"
for required in \
  "$TARGET_ROOT/node/bin/node" \
  "$TARGET_ROOT/bin/bpa-managed-chrome" \
  "$TARGET_ROOT/bin/bpa-managed-chrome-agent.js" \
  "$CURRENT_ROOT/node/bin/node" \
  "$CURRENT_ROOT/bin/bpa" \
  "$CURRENT_ROOT/bin/bpa-managed-chrome-agent.js"; do
  if [[ ! -x "$required" && "${required:e}" != "js" ]]; then
    print -u2 "Rollback closure file is unavailable: $required"
    exit 1
  fi
  if [[ "${required:e}" == "js" && ! -f "$required" ]]; then
    print -u2 "Rollback closure file is unavailable: $required"
    exit 1
  fi
done
"$TARGET_ROOT/node/bin/node" \
  "$TARGET_ROOT/bin/bpa-runtime-verify.js" \
  "$TARGET_ROOT"
if [[ ! -f "$TARGET_EXTENSION/manifest.json" || \
  ! -f "$CORE_LAUNCH_AGENT" || ! -f "$CHROME_LAUNCH_AGENT" ]]; then
  print -u2 "Rollback requires complete Core, managed Chrome, and Extension assets."
  exit 1
fi

TARGET_SCHEMA="$(
  "$TARGET_ROOT/node/bin/node" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(manifest.databaseSchemaVersion));
  ' "$TARGET_ROOT/runtime-manifest.json"
)"
LIVE_SCHEMA=0
if [[ -f "$DATA_DB" ]]; then
  LIVE_SCHEMA="$(
    cd "$TARGET_ROOT"
    "$TARGET_ROOT/node/bin/node" --input-type=module -e '
      import Database from "better-sqlite3";
      const database = new Database(process.argv[1], { readonly: true });
      const row = database.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
      ).get();
      database.close();
      process.stdout.write(String(row.version));
    ' "$DATA_DB"
  )"
fi
if (( TARGET_SCHEMA < LIVE_SCHEMA )); then
  print -u2 "Rollback refused: runtime $TARGET_VERSION supports DB Schema $TARGET_SCHEMA, but live data is Schema $LIVE_SCHEMA."
  print -u2 "Use the recorded pre-upgrade backup only after confirming no newer business writes exist."
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

EXTENSION_STAGE="$(mktemp -d "$BPA_ROOT/.extension.rollback.XXXXXX")"
EXTENSION_BACKUP="$BPA_ROOT/.extension.rollback.backup.$$"
MAINTENANCE_RESULT="$BPA_ROOT/.rollback-maintenance.$$.json"
RUNTIME_SWITCHED=false
EXTENSION_SWITCHED=false
CORE_STOPPED=false
CHROME_STOPPED=false

restore_on_failure() {
  local exit_code=$?
  $CHROME_STOPPED && launchctl bootout \
    "gui/$(id -u)/com.bpa.inventory-chrome" 2>/dev/null || true
  $CORE_STOPPED && launchctl bootout \
    "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
  if $EXTENSION_SWITCHED; then
    [[ -d "$EXTENSION_ROOT" ]] && rm -rf "$EXTENSION_ROOT"
    if [[ -d "$EXTENSION_BACKUP" ]]; then
      mv "$EXTENSION_BACKUP" "$EXTENSION_ROOT"
    fi
  fi
  if $RUNTIME_SWITCHED; then
    ln -s "$CURRENT_VERSION" "$RUNTIME_ROOT/current.restore"
    mv -h "$RUNTIME_ROOT/current.restore" "$CURRENT_LINK"
  fi
  [[ -d "$EXTENSION_STAGE" ]] && rm -rf "$EXTENSION_STAGE"
  [[ -f "$MAINTENANCE_RESULT" ]] && rm "$MAINTENANCE_RESULT"
  rmdir "$MAINTENANCE_LOCK" 2>/dev/null || true
  rmdir "$INSTALL_LOCK" 2>/dev/null || true
  if $CORE_STOPPED; then
    launchctl bootstrap "gui/$(id -u)" "$CORE_LAUNCH_AGENT" 2>/dev/null || true
  fi
  if $CHROME_STOPPED; then
    launchctl bootstrap "gui/$(id -u)" "$CHROME_LAUNCH_AGENT" 2>/dev/null || true
  fi
  exit $exit_code
}
trap restore_on_failure EXIT

CORE_PID="$(
  launchctl print "gui/$(id -u)/com.bpa.core" 2>/dev/null |
    awk '/pid =/{print $3; exit}' || true
)"
CHROME_PID="$(
  launchctl print "gui/$(id -u)/com.bpa.inventory-chrome" 2>/dev/null |
    awk '/pid =/{print $3; exit}' || true
)"
if [[ -z "$CORE_PID" || -z "$CHROME_PID" ]]; then
  print -u2 "Rollback requires the verified Core and managed Chrome to be running."
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
  print -u2 "BPA Runtime effects did not drain before the rollback deadline."
  exit 1
fi

rsync -a "$TARGET_EXTENSION/" "$EXTENSION_STAGE/"
CHROME_STOPPED=true
launchctl bootout "gui/$(id -u)/com.bpa.inventory-chrome"
CORE_STOPPED=true
launchctl bootout "gui/$(id -u)/com.bpa.core"

ln -s "$TARGET_VERSION" "$RUNTIME_ROOT/current.rollback"
mv -h "$RUNTIME_ROOT/current.rollback" "$CURRENT_LINK"
RUNTIME_SWITCHED=true
if [[ -d "$EXTENSION_ROOT" ]]; then
  mv "$EXTENSION_ROOT" "$EXTENSION_BACKUP"
fi
EXTENSION_SWITCHED=true
mv "$EXTENSION_STAGE" "$EXTENSION_ROOT"

launchctl bootstrap "gui/$(id -u)" "$CORE_LAUNCH_AGENT"
launchctl kickstart -k "gui/$(id -u)/com.bpa.core"
launchctl bootstrap "gui/$(id -u)" "$CHROME_LAUNCH_AGENT"
for _attempt in {1..50}; do
  if BPA_HOME="$BPA_ROOT" "$TARGET_ROOT/bin/bpa" doctor >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
BPA_HOME="$BPA_ROOT" "$TARGET_ROOT/bin/bpa" doctor >/dev/null
NEW_CORE_PID="$(
  launchctl print "gui/$(id -u)/com.bpa.core" |
    awk '/pid =/{print $3; exit}'
)"
NEW_CHROME_PID=""
for _attempt in {1..50}; do
  NEW_CHROME_PID="$(
    launchctl print "gui/$(id -u)/com.bpa.inventory-chrome" 2>/dev/null |
      awk '/pid =/{print $3; exit}' || true
  )"
  [[ -n "$NEW_CHROME_PID" ]] && break
  sleep 0.2
done
if [[ -z "$NEW_CORE_PID" || -z "$NEW_CHROME_PID" ]]; then
  print -u2 "Rolled-back Core or managed Chrome did not report a PID."
  exit 1
fi
"$TARGET_ROOT/node/bin/node" \
  "$TARGET_ROOT/bin/bpa-core-identity.js" \
  --lock "$BPA_ROOT/run/core.lock" \
  --pid "$NEW_CORE_PID" \
  --identity "$TARGET_VERSION" \
  --executable "$TARGET_ROOT/node/bin/node" \
  --entrypoint "$TARGET_ROOT/bin/bpa-core.js" >/dev/null
"$TARGET_ROOT/node/bin/node" \
  "$TARGET_ROOT/bin/bpa-managed-chrome-agent.js" \
  chrome-verify \
  --manifest "$TARGET_ROOT/runtime-manifest.json" \
  --path "$CHROME_LAUNCH_AGENT" \
  --bpa-home "$BPA_ROOT" \
  --runtime-root "$RUNTIME_ROOT" \
  --log-root "$LOG_ROOT" \
  --pid "$NEW_CHROME_PID" >/dev/null

ln -sfn "$CURRENT_VERSION" "$RUNTIME_ROOT/previous.rollback"
mv -h "$RUNTIME_ROOT/previous.rollback" "$PREVIOUS_LINK"
[[ -d "$EXTENSION_BACKUP" ]] && rm -rf "$EXTENSION_BACKUP"
[[ -f "$MAINTENANCE_RESULT" ]] && rm "$MAINTENANCE_RESULT"
rmdir "$MAINTENANCE_LOCK"
rmdir "$INSTALL_LOCK"
trap - EXIT

print "BPA rolled back to $TARGET_VERSION without changing business data."
print "Managed Chrome and the Browser Bridge were restarted from the verified target closure."
