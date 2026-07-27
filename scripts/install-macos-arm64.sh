#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
VERSION="${BPA_INSTALL_VERSION:-0.1.0}"
USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
RUNTIME_ROOT="$BPA_ROOT/runtime"
VERSION_ROOT="$RUNTIME_ROOT/$VERSION"
DATA_ROOT="$BPA_ROOT/data"
LOG_ROOT="$USER_HOME/Library/Logs/BPA"
LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.core.plist"
HOST_ROOT="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_ROOT/com.bpa.browser.json"
EXTENSION_ID="hoobbnlkcdhbemedpfhhoicklplggmbc"
BUNDLED_NODE="${BPA_BUNDLED_NODE:-$PROJECT_ROOT/bundle/node/bin/node}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 "BPA local v1 only supports macOS arm64."
  exit 1
fi
if [[ ! -x "$BUNDLED_NODE" ]]; then
  print -u2 "Node.js 24 runtime not found: $BUNDLED_NODE"
  print -u2 "Set BPA_BUNDLED_NODE to the packaged Node.js 24 executable."
  exit 1
fi
if [[ "$("$BUNDLED_NODE" -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  print -u2 "The bundled runtime must be Node.js 24 LTS."
  exit 1
fi
if [[ -e "$VERSION_ROOT" ]]; then
  print -u2 "Runtime $VERSION is already installed and will not be overwritten."
  exit 1
fi

mkdir -p "$RUNTIME_ROOT" "$DATA_ROOT" "$LOG_ROOT" "${LAUNCH_AGENT:h}" "$HOST_ROOT"
chmod 700 "$BPA_ROOT" "$DATA_ROOT" "$LOG_ROOT"
STAGING_ROOT="$(mktemp -d "$BPA_ROOT/.install.XXXXXX")"
OLD_AGENT_WAS_RUNNING=false
INSTALL_MOVED=false
RUNTIME_SWITCHED=false
OLD_CURRENT=""
rollback_install() {
  EXIT_CODE=$?
  [[ -d "$STAGING_ROOT" ]] && rm -rf "$STAGING_ROOT"
  if $RUNTIME_SWITCHED; then
    launchctl bootout "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
    if [[ -n "$OLD_CURRENT" ]]; then
      ln -sfn "$OLD_CURRENT" "$RUNTIME_ROOT/current.recover"
      mv -h "$RUNTIME_ROOT/current.recover" "$RUNTIME_ROOT/current"
    else
      [[ -L "$RUNTIME_ROOT/current" ]] && rm "$RUNTIME_ROOT/current"
    fi
  fi
  if $INSTALL_MOVED && [[ -d "$VERSION_ROOT" ]]; then
    rm -rf "$VERSION_ROOT"
  fi
  if $OLD_AGENT_WAS_RUNNING && [[ -f "$LAUNCH_AGENT" ]]; then
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null || true
  fi
  exit $EXIT_CODE
}
trap rollback_install EXIT
mkdir -p "$STAGING_ROOT/workspace" "$STAGING_ROOT/node/bin" "$STAGING_ROOT/bin"

rsync -a \
  --exclude '.git' \
  --exclude '/dist' \
  --exclude '/apps/extension/.wxt' \
  "$PROJECT_ROOT/" "$STAGING_ROOT/workspace/"
cp "$BUNDLED_NODE" "$STAGING_ROOT/node/bin/node"
chmod 755 "$STAGING_ROOT/node/bin/node"

cat > "$STAGING_ROOT/bin/bpa-core" <<EOF
#!/bin/zsh
exec "$VERSION_ROOT/node/bin/node" "$VERSION_ROOT/workspace/node_modules/tsx/dist/cli.mjs" "$VERSION_ROOT/workspace/apps/local-core/src/main.ts" "\$@"
EOF
cat > "$STAGING_ROOT/bin/bpa" <<EOF
#!/bin/zsh
exec "$VERSION_ROOT/node/bin/node" "$VERSION_ROOT/workspace/node_modules/tsx/dist/cli.mjs" "$VERSION_ROOT/workspace/apps/cli/src/main.ts" "\$@"
EOF
cat > "$STAGING_ROOT/bin/bpa-native-host" <<EOF
#!/bin/zsh
exec "$VERSION_ROOT/node/bin/node" "$VERSION_ROOT/workspace/node_modules/tsx/dist/cli.mjs" "$VERSION_ROOT/workspace/apps/native-host/src/main.ts" "\$@"
EOF
chmod 755 "$STAGING_ROOT/bin/"*

if launchctl print "gui/$(id -u)/com.bpa.core" >/dev/null 2>&1; then
  OLD_AGENT_WAS_RUNNING=true
  launchctl bootout "gui/$(id -u)/com.bpa.core"
fi

BPA_HOME="$BPA_ROOT" \
  "$STAGING_ROOT/node/bin/node" \
  "$STAGING_ROOT/workspace/node_modules/tsx/dist/cli.mjs" \
  "$STAGING_ROOT/workspace/apps/local-core/src/main.ts" \
  --migrate-only

mv "$STAGING_ROOT" "$VERSION_ROOT"
INSTALL_MOVED=true

if [[ -L "$RUNTIME_ROOT/current" ]]; then
  CURRENT_TARGET="$(readlink "$RUNTIME_ROOT/current")"
  OLD_CURRENT="$CURRENT_TARGET"
  ln -sfn "$CURRENT_TARGET" "$RUNTIME_ROOT/previous.next"
  mv -h "$RUNTIME_ROOT/previous.next" "$RUNTIME_ROOT/previous"
fi
ln -s "$VERSION" "$RUNTIME_ROOT/current.next"
mv -h "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"
RUNTIME_SWITCHED=true

cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bpa.core</string>
  <key>ProgramArguments</key>
  <array><string>$RUNTIME_ROOT/current/bin/bpa-core</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_ROOT/core.stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_ROOT/core.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>BPA_HOME</key><string>$BPA_ROOT</string></dict>
</dict>
</plist>
EOF
chmod 600 "$LAUNCH_AGENT"

cat > "$HOST_MANIFEST" <<EOF
{
  "name": "com.bpa.browser",
  "description": "BPA local browser bridge",
  "path": "$RUNTIME_ROOT/current/bin/bpa-native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
chmod 600 "$HOST_MANIFEST"

launchctl bootout "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
launchctl kickstart -k "gui/$(id -u)/com.bpa.core"
trap - EXIT

print "BPA $VERSION installed."
print "CLI: $RUNTIME_ROOT/current/bin/bpa"
print "Extension: $RUNTIME_ROOT/current/workspace/apps/extension/.output/chrome-mv3"
