#!/bin/zsh
set -euo pipefail

USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
RUNTIME_ROOT="$USER_HOME/Library/Application Support/BPA/runtime"
PREVIOUS="$RUNTIME_ROOT/previous"
CURRENT="$RUNTIME_ROOT/current"

if [[ ! -L "$PREVIOUS" ]]; then
  print -u2 "No previous BPA runtime is available."
  exit 1
fi
TARGET="$(readlink "$PREVIOUS")"
if [[ ! -d "$RUNTIME_ROOT/$TARGET" ]]; then
  print -u2 "Previous runtime is missing: $TARGET"
  exit 1
fi
ln -s "$TARGET" "$RUNTIME_ROOT/current.rollback"
mv -h "$RUNTIME_ROOT/current.rollback" "$CURRENT"
launchctl kickstart -k "gui/$(id -u)/com.bpa.core"
print "BPA rolled back to $TARGET. Database migrations are intentionally retained."
