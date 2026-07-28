#!/bin/zsh
set -euo pipefail

USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
RUNTIME_ROOT="$BPA_ROOT/runtime"
DATA_DB="$BPA_ROOT/data/bpa.sqlite"
PREVIOUS_LINK="$RUNTIME_ROOT/previous"
CURRENT_LINK="$RUNTIME_ROOT/current"
EXTENSION_ROOT="$BPA_ROOT/extension"
LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.core.plist"

if [[ ! -L "$PREVIOUS_LINK" || ! -L "$CURRENT_LINK" ]]; then
  print -u2 "Both current and previous BPA runtimes are required."
  exit 1
fi

TARGET_VERSION="$(readlink "$PREVIOUS_LINK")"
CURRENT_VERSION="$(readlink "$CURRENT_LINK")"
TARGET_ROOT="$RUNTIME_ROOT/$TARGET_VERSION"
TARGET_EXTENSION="$TARGET_ROOT/extension"
if [[ ! -x "$TARGET_ROOT/node/bin/node" ]]; then
  print -u2 "Previous bundled Node runtime is missing: $TARGET_ROOT"
  exit 1
fi
"$TARGET_ROOT/node/bin/node" \
  "$TARGET_ROOT/bin/bpa-runtime-verify.js" \
  "$TARGET_ROOT"
if [[ ! -f "$TARGET_EXTENSION/manifest.json" ]]; then
  print -u2 "Previous extension build is missing: $TARGET_EXTENSION"
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

EXTENSION_STAGE="$(mktemp -d "$BPA_ROOT/.extension.rollback.XXXXXX")"
EXTENSION_BACKUP="$BPA_ROOT/.extension.rollback.backup.$$"
RUNTIME_SWITCHED=false
EXTENSION_SWITCHED=false

restore_on_failure() {
  local exit_code=$?
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
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
  exit $exit_code
}
trap restore_on_failure EXIT

rsync -a "$TARGET_EXTENSION/" "$EXTENSION_STAGE/"
launchctl bootout "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
ln -s "$TARGET_VERSION" "$RUNTIME_ROOT/current.rollback"
mv -h "$RUNTIME_ROOT/current.rollback" "$CURRENT_LINK"
RUNTIME_SWITCHED=true

if [[ -d "$EXTENSION_ROOT" ]]; then
  mv "$EXTENSION_ROOT" "$EXTENSION_BACKUP"
fi
EXTENSION_SWITCHED=true
mv "$EXTENSION_STAGE" "$EXTENSION_ROOT"

launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
launchctl kickstart -k "gui/$(id -u)/com.bpa.core"
for _attempt in {1..50}; do
  if BPA_HOME="$BPA_ROOT" "$TARGET_ROOT/bin/bpa" doctor >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
BPA_HOME="$BPA_ROOT" "$TARGET_ROOT/bin/bpa" doctor >/dev/null
[[ -d "$EXTENSION_BACKUP" ]] && rm -rf "$EXTENSION_BACKUP"
trap - EXIT

print "BPA rolled back to $TARGET_VERSION without changing business data."
print "Reload BPA Browser Bridge in Chrome to activate the rolled-back extension."
