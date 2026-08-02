#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
BUNDLED_NODE="${BPA_BUNDLED_NODE:-}"

if [[ -z "$BUNDLED_NODE" || ! -x "$BUNDLED_NODE" ]]; then
  print -u2 "Set BPA_BUNDLED_NODE to the repository Node.js 24 executable."
  exit 1
fi
if [[ "$("$BUNDLED_NODE" -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  print -u2 "The Windows cross-build requires Node.js 24."
  exit 1
fi
for command in curl unzip zip shasum file grep; do
  if ! command -v "$command" >/dev/null 2>&1; then
    print -u2 "Required Windows packaging command is missing: $command"
    exit 1
  fi
done

cd "$PROJECT_ROOT"
if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  print -u2 "Release packages must be built from a clean tracked Git checkout."
  exit 1
fi

RUNTIME_VERSION="$("$BUNDLED_NODE" -p 'require("./package.json").version')"
NODE_VERSION="$("$BUNDLED_NODE" -p 'process.versions.node')"
GIT_COMMIT="$(git rev-parse HEAD)"
RELEASE_IDENTITY="v${RUNTIME_VERSION}-rc.$(print -n "$GIT_COMMIT" | cut -c1-12).node${NODE_VERSION}"
EXPECTED_BASENAME="bpa-local-${RELEASE_IDENTITY}-windows-x64.zip"
OUTPUT="${BPA_PACKAGE_OUTPUT:-$PROJECT_ROOT/artifacts/$EXPECTED_BASENAME}"
OUTPUT="${OUTPUT:A}"
if [[ "${OUTPUT:t}" != "$EXPECTED_BASENAME" ]]; then
  print -u2 "Release archive must be named $EXPECTED_BASENAME."
  exit 1
fi
if [[ -e "$OUTPUT" || -e "$OUTPUT.sha256" ]]; then
  print -u2 "Release output already exists and will not be overwritten: $OUTPUT"
  exit 1
fi

PATH="${BUNDLED_NODE:h}:$PATH" pnpm verify
"$BUNDLED_NODE" --test "$PROJECT_ROOT/scripts/release-gates.check.mjs"

PACKAGE_ROOT="$(mktemp -d /tmp/bpa-windows-package.XXXXXX)"
trap 'rm -rf "$PACKAGE_ROOT"' EXIT
mkdir -p "$PACKAGE_ROOT/bpa" "${OUTPUT:h}"

NODE_ARCHIVE="node-v${NODE_VERSION}-win-x64.zip"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
curl --fail --location --silent --show-error \
  "$NODE_BASE_URL/$NODE_ARCHIVE" \
  --output "$PACKAGE_ROOT/$NODE_ARCHIVE"
curl --fail --location --silent --show-error \
  "$NODE_BASE_URL/SHASUMS256.txt" \
  --output "$PACKAGE_ROOT/SHASUMS256.txt"
(
  cd "$PACKAGE_ROOT"
  grep "  ${NODE_ARCHIVE}$" SHASUMS256.txt | shasum -a 256 -c -
  unzip -q "$NODE_ARCHIVE"
)
WINDOWS_NODE="$PACKAGE_ROOT/node-v${NODE_VERSION}-win-x64/node.exe"
if [[ "$(file "$WINDOWS_NODE")" != *"PE32+"*"x86-64"* ]]; then
  print -u2 "Downloaded Node.js executable is not Windows x64."
  exit 1
fi

SQLITE_STAGE="$PACKAGE_ROOT/sqlite"
SQLITE_PACKAGE="$PROJECT_ROOT/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3"
mkdir -p "$SQLITE_STAGE/lib"
cp "$SQLITE_PACKAGE/package.json" "$SQLITE_STAGE/package.json"
cp "$SQLITE_PACKAGE/LICENSE" "$SQLITE_STAGE/LICENSE"
cp -R "$SQLITE_PACKAGE/lib/." "$SQLITE_STAGE/lib/"
(
  cd "$SQLITE_STAGE"
  "$BUNDLED_NODE" \
    "$PROJECT_ROOT/node_modules/.pnpm/prebuild-install@7.1.3/node_modules/prebuild-install/bin.js" \
    --platform win32 \
    --arch x64 \
    --runtime node \
    --target "$NODE_VERSION"
)
WINDOWS_SQLITE="$SQLITE_STAGE/build/Release/better_sqlite3.node"
if [[ "$(file "$WINDOWS_SQLITE")" != *"PE32+"*"x86-64"* ]]; then
  print -u2 "Downloaded better-sqlite3 module is not Windows x64."
  exit 1
fi

SEA_ROOT="$PACKAGE_ROOT/sea"
mkdir -p "$SEA_ROOT"
PATH="${BUNDLED_NODE:h}:$PATH" pnpm exec esbuild \
  "$PROJECT_ROOT/apps/native-host/src/main.ts" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node24 \
  --outfile="$SEA_ROOT/bpa-native-host.cjs"
"$BUNDLED_NODE" --input-type=module -e '
  import { writeFileSync } from "node:fs";
  writeFileSync(
    process.argv[1],
    `${JSON.stringify({
      main: process.argv[2],
      output: process.argv[3],
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    }, null, 2)}\n`
  );
' \
  "$SEA_ROOT/sea-config.json" \
  "bpa-native-host.cjs" \
  "sea-prep.blob"
(
  cd "$SEA_ROOT"
  "$BUNDLED_NODE" --experimental-sea-config sea-config.json
)
cp "$WINDOWS_NODE" "$SEA_ROOT/bpa-native-host.exe"
PATH="${BUNDLED_NODE:h}:$PATH" pnpm exec postject \
  "$SEA_ROOT/bpa-native-host.exe" \
  NODE_SEA_BLOB \
  "$SEA_ROOT/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

BPA_TARGET_PLATFORM=win32 \
BPA_TARGET_ARCHITECTURE=x64 \
BPA_TARGET_NODE_VERSION="$NODE_VERSION" \
BPA_TARGET_NODE_EXECUTABLE="$WINDOWS_NODE" \
BPA_TARGET_SQLITE_BINARY="$WINDOWS_SQLITE" \
BPA_TARGET_NATIVE_HOST_EXECUTABLE="$SEA_ROOT/bpa-native-host.exe" \
  "$BUNDLED_NODE" \
  "$PROJECT_ROOT/scripts/build-runtime-closure.mjs" \
  "$PACKAGE_ROOT/bpa/runtime"

cp "$PROJECT_ROOT/scripts/install-windows-x64.ps1" "$PACKAGE_ROOT/bpa/install.ps1"
cp "$PROJECT_ROOT/scripts/rollback-windows.ps1" "$PACKAGE_ROOT/bpa/rollback.ps1"
cp "$PROJECT_ROOT/scripts/uninstall-windows.ps1" "$PACKAGE_ROOT/bpa/uninstall.ps1"
cp "$PROJECT_ROOT/scripts/windows-runtime-common.ps1" \
  "$PACKAGE_ROOT/bpa/runtime-common.ps1"

"$BUNDLED_NODE" \
  "$PACKAGE_ROOT/bpa/runtime/bin/bpa-runtime-verify.js" \
  "$PACKAGE_ROOT/bpa/runtime" \
  --static-host
"$BUNDLED_NODE" \
  "$PACKAGE_ROOT/bpa/runtime/bin/bpa-release-scan.js" \
  "$PACKAGE_ROOT/bpa"

(
  cd "$PACKAGE_ROOT"
  zip -q -X -r "$OUTPUT" bpa
)
(
  cd "${OUTPUT:h}"
  shasum -a 256 "${OUTPUT:t}" > "${OUTPUT:t}.sha256"
)
"$PROJECT_ROOT/scripts/verify-package-windows-x64.sh" "$OUTPUT"
print "$OUTPUT"
