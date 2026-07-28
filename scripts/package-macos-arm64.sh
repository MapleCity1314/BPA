#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
BUNDLED_NODE="${BPA_BUNDLED_NODE:-}"

if [[ -z "$BUNDLED_NODE" || ! -x "$BUNDLED_NODE" ]]; then
  print -u2 "Set BPA_BUNDLED_NODE to a Node.js 24 macOS arm64 executable."
  exit 1
fi
if [[ "$("$BUNDLED_NODE" -p 'process.platform + ":" + process.arch + ":" + process.versions.node.split(".")[0]')" != "darwin:arm64:24" ]]; then
  print -u2 "Runtime must be Node.js 24 for darwin-arm64."
  exit 1
fi

cd "$PROJECT_ROOT"
if [[ -n "$(git status --porcelain=v1 --untracked-files=no)" ]]; then
  print -u2 "Release packages must be built from a clean tracked Git checkout."
  exit 1
fi
RUNTIME_VERSION="$("$BUNDLED_NODE" -p 'require("./package.json").version')"
GIT_COMMIT="$(git rev-parse HEAD)"
RELEASE_IDENTITY="v${RUNTIME_VERSION}-rc.$(print -n "$GIT_COMMIT" | cut -c1-12)"
EXPECTED_BASENAME="bpa-local-${RELEASE_IDENTITY}-macos-arm64.tar.gz"
OUTPUT="${BPA_PACKAGE_OUTPUT:-$PROJECT_ROOT/artifacts/$EXPECTED_BASENAME}"
OUTPUT="${OUTPUT:A}"
if [[ "${OUTPUT:t}" != "$EXPECTED_BASENAME" ]]; then
  print -u2 "Release archive must be named $EXPECTED_BASENAME."
  print -u2 "Legacy or mismatched output names are refused and will not be overwritten."
  exit 1
fi
if [[ -e "$OUTPUT" || -e "$OUTPUT.sha256" ]]; then
  print -u2 "Release output already exists and will not be overwritten: $OUTPUT"
  exit 1
fi

PATH="${BUNDLED_NODE:h}:$PATH" pnpm verify
"$BUNDLED_NODE" --test "$PROJECT_ROOT/scripts/release-gates.check.mjs"
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
(
  cd "${OUTPUT:h}"
  shasum -a 256 "${OUTPUT:t}" > "${OUTPUT:t}.sha256"
)
"$PROJECT_ROOT/scripts/verify-package-macos-arm64.sh" "$OUTPUT"
print "$OUTPUT"
