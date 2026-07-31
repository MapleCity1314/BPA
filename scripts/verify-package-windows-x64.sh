#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
ARCHIVE="${1:-}"
NODE="${BPA_BUNDLED_NODE:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  print -u2 "Provide a BPA Windows x64 release archive."
  exit 1
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  print -u2 "Set BPA_BUNDLED_NODE to Node.js 24."
  exit 1
fi

STAGE="$(mktemp -d /tmp/bpa-windows-verify.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
unzip -q "$ARCHIVE" -d "$STAGE"
ROOT="$STAGE/bpa"
for required in \
  install.ps1 \
  rollback.ps1 \
  uninstall.ps1 \
  runtime/runtime-manifest.json \
  runtime/node/node.exe \
  runtime/bin/bpa-native-host.exe \
  runtime/extension/manifest.json; do
  if [[ ! -f "$ROOT/$required" ]]; then
    print -u2 "Windows package is missing $required."
    exit 1
  fi
done
if find "$ROOT" -type l -print -quit | rg . >/dev/null; then
  print -u2 "Windows package contains a symbolic link."
  exit 1
fi
"$NODE" \
  "$ROOT/runtime/bin/bpa-runtime-verify.js" \
  "$ROOT/runtime" \
  --static-host
"$NODE" "$ROOT/runtime/bin/bpa-release-scan.js" "$ROOT"
"$NODE" --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (
    manifest.platform !== "win32" ||
    manifest.architecture !== "x64" ||
    !String(manifest.nodeVersion).startsWith("24.")
  ) process.exit(1);
' "$ROOT/runtime/runtime-manifest.json"
if [[ "$(file "$ROOT/runtime/node/node.exe")" != *"PE32+"*"x86-64"* ]]; then
  print -u2 "Packaged Node.js is not Windows x64."
  exit 1
fi
if [[ "$(file "$ROOT/runtime/bin/bpa-native-host.exe")" != *"PE32+"*"x86-64"* ]]; then
  print -u2 "Packaged Native Host is not Windows x64."
  exit 1
fi
print "Verified BPA Windows x64 production archive: $ARCHIVE"
