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
pnpm schema:check
pnpm check
pnpm build
PACKAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_ROOT"' EXIT
mkdir -p "$PACKAGE_ROOT/bpa/bundle/node/bin" "${OUTPUT:h}"
rsync -a \
  --exclude '.git' \
  --exclude 'artifacts' \
  --exclude 'apps/docs' \
  --exclude '/CLAUDE.md' \
  "$PROJECT_ROOT/" "$PACKAGE_ROOT/bpa/"
cp "$BUNDLED_NODE" "$PACKAGE_ROOT/bpa/bundle/node/bin/node"
chmod 755 "$PACKAGE_ROOT/bpa/bundle/node/bin/node"
PNPM_CLI="$(command -v pnpm)"
(
  cd "$PACKAGE_ROOT/bpa"
  PATH="$PACKAGE_ROOT/bpa/bundle/node/bin:$PATH" \
    "$PACKAGE_ROOT/bpa/bundle/node/bin/node" \
    "$PNPM_CLI" rebuild better-sqlite3
  BPA_HOME="$PACKAGE_ROOT/verify-data" \
    "$PACKAGE_ROOT/bpa/bundle/node/bin/node" \
    --import tsx \
    apps/local-core/src/main.ts \
    --migrate-only
)
rm -rf "$PACKAGE_ROOT/verify-data"
tar -C "$PACKAGE_ROOT" -czf "$OUTPUT" bpa
print "$OUTPUT"
