#!/bin/zsh
set -euo pipefail

SCRIPT_ROOT="${0:A:h}"
if [[ -d "$SCRIPT_ROOT/runtime" ]]; then
  # Production archives place install.sh beside runtime/.
  PROJECT_ROOT="$SCRIPT_ROOT"
else
  # Repository execution keeps the installer under scripts/.
  PROJECT_ROOT="${SCRIPT_ROOT:h}"
fi
VERSION="${BPA_INSTALL_VERSION:-0.3.0}"
USER_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')"
BPA_ROOT="$USER_HOME/Library/Application Support/BPA"
RUNTIME_ROOT="$BPA_ROOT/runtime"
VERSION_ROOT="$RUNTIME_ROOT/$VERSION"
DATA_ROOT="$BPA_ROOT/data"
DATA_DB="$DATA_ROOT/bpa.sqlite"
BACKUP_ROOT="$BPA_ROOT/backups"
EXTENSION_ROOT="$BPA_ROOT/extension"
LOG_ROOT="$USER_HOME/Library/Logs/BPA"
LAUNCH_AGENT="$USER_HOME/Library/LaunchAgents/com.bpa.core.plist"
HOST_ROOT="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_ROOT/com.bpa.browser.json"
EXTENSION_ID="hoobbnlkcdhbemedpfhhoicklplggmbc"
PACKAGED_RUNTIME="$PROJECT_ROOT/runtime"
BUNDLED_NODE="${BPA_BUNDLED_NODE:-$PACKAGED_RUNTIME/node/bin/node}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 "BPA local v1 only supports macOS arm64."
  exit 1
fi
if [[ ! -x "$BUNDLED_NODE" ]]; then
  print -u2 "Packaged Node.js 24 runtime not found: $BUNDLED_NODE"
  exit 1
fi
if [[ "$("$BUNDLED_NODE" -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  print -u2 "The bundled runtime must be Node.js 24 LTS."
  exit 1
fi
if [[ ! -f "$PACKAGED_RUNTIME/runtime-manifest.json" ]]; then
  print -u2 "Runtime manifest is missing."
  exit 1
fi
"$BUNDLED_NODE" \
  "$PACKAGED_RUNTIME/bin/bpa-runtime-verify.js" \
  "$PACKAGED_RUNTIME"
if [[ -e "$VERSION_ROOT" ]]; then
  print -u2 "Runtime $VERSION is already installed and will not be overwritten."
  exit 1
fi

mkdir -p \
  "$RUNTIME_ROOT" "$DATA_ROOT" "$BACKUP_ROOT" "$LOG_ROOT" \
  "${LAUNCH_AGENT:h}" "$HOST_ROOT"
chmod 700 "$BPA_ROOT" "$DATA_ROOT" "$BACKUP_ROOT" "$LOG_ROOT"
STAGING_ROOT="$(mktemp -d "$BPA_ROOT/.install.XXXXXX")"
MIGRATION_TEST_ROOT="$(mktemp -d "$BPA_ROOT/.migration-test.XXXXXX")"
EXTENSION_STAGE="$(mktemp -d "$BPA_ROOT/.extension.install.XXXXXX")"
EXTENSION_BACKUP="$BPA_ROOT/.extension.rollback.$VERSION.$$"
DATABASE_BACKUP=""
POST_MIGRATION_DIGEST=""
OLD_AGENT_WAS_RUNNING=false
OLD_CORE_PID=""
INSTALL_MOVED=false
RUNTIME_SWITCHED=false
EXTENSION_SWITCHED=false
OLD_CURRENT=""

checkpoint_and_check() {
  local database_path="$1"
  (
    cd "$STAGING_ROOT"
    "$STAGING_ROOT/node/bin/node" --input-type=module -e '
      import Database from "better-sqlite3";
      const database = new Database(process.argv[1]);
      database.pragma("wal_checkpoint(TRUNCATE)");
      const rows = database.pragma("integrity_check");
      database.close();
      if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
        throw new Error("SQLite integrity_check failed");
      }
    ' "$database_path"
  )
}

rollback_install() {
  local exit_code=$?
  launchctl bootout "gui/$(id -u)/com.bpa.core" 2>/dev/null || true
  if [[ -n "$DATABASE_BACKUP" && -f "$DATABASE_BACKUP" && -f "$DATA_DB" ]]; then
    checkpoint_and_check "$DATA_DB" || true
    local current_digest
    current_digest="$(shasum -a 256 "$DATA_DB" | awk '{print $1}')"
    if [[ -n "$POST_MIGRATION_DIGEST" && "$current_digest" != "$POST_MIGRATION_DIGEST" ]]; then
      print -u2 "Database changed after runtime switch; automatic runtime/database rollback was refused."
      print -u2 "The installed runtime and database backup were preserved for manual recovery."
      [[ -d "$MIGRATION_TEST_ROOT" ]] && rm -rf "$MIGRATION_TEST_ROOT"
      [[ -d "$EXTENSION_STAGE" ]] && rm -rf "$EXTENSION_STAGE"
      exit $exit_code
    fi
  fi
  if $EXTENSION_SWITCHED; then
    [[ -d "$EXTENSION_ROOT" ]] && rm -rf "$EXTENSION_ROOT"
    if [[ -d "$EXTENSION_BACKUP" ]]; then
      mv "$EXTENSION_BACKUP" "$EXTENSION_ROOT"
    fi
  fi
  if $RUNTIME_SWITCHED; then
    if [[ -n "$OLD_CURRENT" ]]; then
      ln -sfn "$OLD_CURRENT" "$RUNTIME_ROOT/current.recover"
      mv -h "$RUNTIME_ROOT/current.recover" "$RUNTIME_ROOT/current"
    else
      [[ -L "$RUNTIME_ROOT/current" ]] && rm "$RUNTIME_ROOT/current"
    fi
  fi
  if [[ -n "$DATABASE_BACKUP" && -f "$DATABASE_BACKUP" ]]; then
    cp "$DATABASE_BACKUP" "$DATA_DB"
    chmod 600 "$DATA_DB"
  fi
  [[ -d "$STAGING_ROOT" ]] && rm -rf "$STAGING_ROOT"
  [[ -d "$MIGRATION_TEST_ROOT" ]] && rm -rf "$MIGRATION_TEST_ROOT"
  [[ -d "$EXTENSION_STAGE" ]] && rm -rf "$EXTENSION_STAGE"
  if $INSTALL_MOVED && [[ -d "$VERSION_ROOT" ]]; then
    rm -rf "$VERSION_ROOT"
  fi
  if $OLD_AGENT_WAS_RUNNING && [[ -f "$LAUNCH_AGENT" ]]; then
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null || true
  fi
  exit $exit_code
}
trap rollback_install EXIT

rsync -a "$PACKAGED_RUNTIME/" "$STAGING_ROOT/"
"$STAGING_ROOT/node/bin/node" \
  "$STAGING_ROOT/bin/bpa-runtime-verify.js" \
  "$STAGING_ROOT"
cat > "$STAGING_ROOT/bin/bpa-core" <<EOF
#!/bin/zsh
exec "$RUNTIME_ROOT/current/node/bin/node" "$RUNTIME_ROOT/current/bin/bpa-core.js" "\$@"
EOF
cat > "$STAGING_ROOT/bin/bpa" <<EOF
#!/bin/zsh
exec "$RUNTIME_ROOT/current/node/bin/node" "$RUNTIME_ROOT/current/bin/bpa.js" "\$@"
EOF
cat > "$STAGING_ROOT/bin/bpa-native-host" <<EOF
#!/bin/zsh
exec "$RUNTIME_ROOT/current/node/bin/node" "$RUNTIME_ROOT/current/bin/bpa-native-host.js" "\$@"
EOF
cat > "$STAGING_ROOT/bin/bpa-mcp" <<EOF
#!/bin/zsh
exec "$RUNTIME_ROOT/current/node/bin/node" "$RUNTIME_ROOT/current/bin/bpa-mcp.js" "\$@"
EOF
chmod 755 "$STAGING_ROOT/bin/"*
rsync -a "$STAGING_ROOT/extension/" "$EXTENSION_STAGE/"

(
  cd "$STAGING_ROOT"
  "$STAGING_ROOT/node/bin/node" -e \
    'import("better-sqlite3").then(({default: Database}) => new Database(":memory:").close())'
)

if launchctl print "gui/$(id -u)/com.bpa.core" >/dev/null 2>&1; then
  OLD_AGENT_WAS_RUNNING=true
  OLD_CORE_PID="$(
    launchctl print "gui/$(id -u)/com.bpa.core" |
      awk '/pid =/{print $3; exit}'
  )"
  launchctl bootout "gui/$(id -u)/com.bpa.core"
  if [[ -n "$OLD_CORE_PID" ]]; then
    for _attempt in {1..100}; do
      if ! kill -0 "$OLD_CORE_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$OLD_CORE_PID" 2>/dev/null; then
      print -u2 "Previous BPA Core PID $OLD_CORE_PID did not stop in time."
      exit 1
    fi
  fi
fi

if [[ -f "$DATA_DB" ]]; then
  checkpoint_and_check "$DATA_DB"
  DATABASE_BACKUP="$BACKUP_ROOT/bpa-before-$VERSION-$(date +%Y%m%d%H%M%S).sqlite"
  cp "$DATA_DB" "$DATABASE_BACKUP"
  chmod 600 "$DATABASE_BACKUP"
  mkdir -p "$MIGRATION_TEST_ROOT/data"
  cp "$DATABASE_BACKUP" "$MIGRATION_TEST_ROOT/data/bpa.sqlite"
fi
(
  BPA_HOME="$MIGRATION_TEST_ROOT" \
    "$STAGING_ROOT/node/bin/node" \
    "$STAGING_ROOT/bin/bpa-core.js" --migrate-only
)
checkpoint_and_check "$MIGRATION_TEST_ROOT/data/bpa.sqlite"
(
  BPA_HOME="$BPA_ROOT" \
    "$STAGING_ROOT/node/bin/node" \
    "$STAGING_ROOT/bin/bpa-core.js" --migrate-only
)
checkpoint_and_check "$DATA_DB"
POST_MIGRATION_DIGEST="$(shasum -a 256 "$DATA_DB" | awk '{print $1}')"

mv "$STAGING_ROOT" "$VERSION_ROOT"
INSTALL_MOVED=true

if [[ -L "$RUNTIME_ROOT/current" ]]; then
  OLD_CURRENT="$(readlink "$RUNTIME_ROOT/current")"
  ln -sfn "$OLD_CURRENT" "$RUNTIME_ROOT/previous.next"
  mv -h "$RUNTIME_ROOT/previous.next" "$RUNTIME_ROOT/previous"
fi
ln -s "$VERSION" "$RUNTIME_ROOT/current.next"
mv -h "$RUNTIME_ROOT/current.next" "$RUNTIME_ROOT/current"
RUNTIME_SWITCHED=true

if [[ -d "$EXTENSION_ROOT" ]]; then
  mv "$EXTENSION_ROOT" "$EXTENSION_BACKUP"
fi
EXTENSION_SWITCHED=true
mv "$EXTENSION_STAGE" "$EXTENSION_ROOT"

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

launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
launchctl kickstart -k "gui/$(id -u)/com.bpa.core"
HEALTH_RESULT="$BPA_ROOT/.install-health.$VERSION.$$.json"
HEALTH_OK=false
for _attempt in {1..50}; do
  if BPA_HOME="$BPA_ROOT" "$VERSION_ROOT/bin/bpa" doctor > "$HEALTH_RESULT" 2>/dev/null; then
    if "$VERSION_ROOT/node/bin/node" --input-type=module -e '
      import { readFileSync } from "node:fs";
      const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
      if (result.status !== "ok" || result.persistence?.writable !== true) process.exit(1);
    ' "$HEALTH_RESULT"; then
      HEALTH_OK=true
      break
    fi
  fi
  sleep 0.2
done
if ! $HEALTH_OK; then
  print -u2 "BPA Core health check did not complete."
  exit 1
fi
if [[ ! -f "$EXTENSION_ROOT/manifest.json" || ! -f "$HOST_MANIFEST" ]]; then
  print -u2 "Extension or Native Host installation is incomplete."
  exit 1
fi
rm "$HEALTH_RESULT"
[[ -d "$MIGRATION_TEST_ROOT" ]] && rm -rf "$MIGRATION_TEST_ROOT"
[[ -d "$EXTENSION_BACKUP" ]] && rm -rf "$EXTENSION_BACKUP"
trap - EXIT

print "BPA $VERSION installed from a verified production closure."
print "CLI: $RUNTIME_ROOT/current/bin/bpa"
print "Extension: $EXTENSION_ROOT"
if [[ -n "$DATABASE_BACKUP" ]]; then
  print "Pre-upgrade database backup: $DATABASE_BACKUP"
fi
