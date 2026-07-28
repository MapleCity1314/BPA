#!/bin/zsh
set -euo pipefail

USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
RUNTIME_ROOT="$BPA_ROOT/runtime"
PREVIOUS_LINK="$RUNTIME_ROOT/previous"
CURRENT_LINK="$RUNTIME_ROOT/current"
EXTENSION_ROOT="$BPA_ROOT/extension"

if [[ ! -L "$PREVIOUS_LINK" ]]; then
  print -u2 "No previous BPA runtime is available."
  exit 1
fi
if [[ ! -L "$CURRENT_LINK" ]]; then
  print -u2 "Current BPA runtime link is missing."
  exit 1
fi

TARGET_VERSION="$(readlink "$PREVIOUS_LINK")"
CURRENT_VERSION="$(readlink "$CURRENT_LINK")"
TARGET_ROOT="$RUNTIME_ROOT/$TARGET_VERSION"
TARGET_EXTENSION="$TARGET_ROOT/workspace/apps/extension/.output/chrome-mv3"
if [[ ! -d "$TARGET_ROOT" ]]; then
  print -u2 "Previous runtime is missing: $TARGET_VERSION"
  exit 1
fi
if [[ ! -f "$TARGET_EXTENSION/manifest.json" ]]; then
  print -u2 "Previous extension build is missing: $TARGET_EXTENSION"
  exit 1
fi

EXTENSION_STAGE="$(mktemp -d "$BPA_ROOT/.extension.rollback.XXXXXX")"
EXTENSION_BACKUP="$BPA_ROOT/.extension.rollback.backup.$$"
RUNTIME_SWITCHED=false
EXTENSION_SWITCHED=false

restore_on_failure() {
  EXIT_CODE=$?
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
  launchctl kickstart -k "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
  exit $EXIT_CODE
}
trap restore_on_failure EXIT

rsync -a "$TARGET_EXTENSION/" "$EXTENSION_STAGE/"
ln -s "$TARGET_VERSION" "$RUNTIME_ROOT/current.rollback"
mv -h "$RUNTIME_ROOT/current.rollback" "$CURRENT_LINK"
RUNTIME_SWITCHED=true

if [[ -d "$EXTENSION_ROOT" ]]; then
  mv "$EXTENSION_ROOT" "$EXTENSION_BACKUP"
fi
EXTENSION_SWITCHED=true
mv "$EXTENSION_STAGE" "$EXTENSION_ROOT"

launchctl kickstart -k "gui/$(id -u)/com.bpa.core"
[[ -d "$EXTENSION_BACKUP" ]] && rm -rf "$EXTENSION_BACKUP"
trap - EXIT

print "BPA rolled back to $TARGET_VERSION. Database migrations are intentionally retained."
print "Reload BPA Browser Bridge in Chrome to activate the rolled-back extension."
