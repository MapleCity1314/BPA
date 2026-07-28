#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
BUNDLED_NODE="${BPA_BUNDLED_NODE:-}"
OUTPUT="${BPA_PACKAGE_OUTPUT:-$PROJECT_ROOT/artifacts/bpa-local-v0.3.0-macos-arm64.tar.gz}"

if [[ -z "$BUNDLED_NODE" || ! -x "$BUNDLED_NODE" ]]; then
  print -u2 "Set BPA_BUNDLED_NODE to a Node.js 24 macOS arm64 executable."
  exit 1
fi
if [[ "$("$BUNDLED_NODE" -p 'process.platform + ":" + process.arch + ":" + process.versions.node.split(".")[0]')" != "darwin:arm64:24" ]]; then
  print -u2 "Runtime must be Node.js 24 for darwin-arm64."
  exit 1
fi

cd "$PROJECT_ROOT"
pnpm verify
PACKAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_ROOT"' EXIT
mkdir -p "$PACKAGE_ROOT/bpa" "${OUTPUT:h}"
"$BUNDLED_NODE" \
  "$PROJECT_ROOT/scripts/build-runtime-closure.mjs" \
  "$PACKAGE_ROOT/bpa/runtime"
cp "$PROJECT_ROOT/scripts/install-macos-arm64.sh" "$PACKAGE_ROOT/bpa/install.sh"
cp "$PROJECT_ROOT/scripts/rollback-macos.sh" "$PACKAGE_ROOT/bpa/rollback.sh"
cp "$PROJECT_ROOT/scripts/uninstall-macos.sh" "$PACKAGE_ROOT/bpa/uninstall.sh"
chmod 755 "$PACKAGE_ROOT/bpa/"*.sh
(
  cd "$PACKAGE_ROOT/bpa/runtime"
  "$PACKAGE_ROOT/bpa/runtime/node/bin/node" -e \
    'import("better-sqlite3").then(({default: Database}) => new Database(":memory:").close())'
  BPA_HOME="$PACKAGE_ROOT/verify-data" \
    "$PACKAGE_ROOT/bpa/runtime/node/bin/node" \
    "$PACKAGE_ROOT/bpa/runtime/bin/bpa-core.js" --migrate-only
)
rm -rf "$PACKAGE_ROOT/verify-data"
tar -C "$PACKAGE_ROOT" -czf "$OUTPUT" bpa
shasum -a 256 "$OUTPUT" > "$OUTPUT.sha256"
"$PROJECT_ROOT/scripts/verify-package-macos-arm64.sh" "$OUTPUT"
print "$OUTPUT"
