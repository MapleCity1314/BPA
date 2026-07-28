#!/bin/zsh
set -euo pipefail

ARCHIVE="${1:A}"
if [[ ! -f "$ARCHIVE" ]]; then
  print -u2 "Usage: $0 /absolute/path/to/bpa-local-<version>-macos-arm64.tar.gz"
  exit 1
fi

VERIFY_ROOT="$(mktemp -d)"
CORE_PID=""
cleanup() {
  if [[ -n "$CORE_PID" ]] && kill -0 "$CORE_PID" 2>/dev/null; then
    kill "$CORE_PID" 2>/dev/null || true
    wait "$CORE_PID" 2>/dev/null || true
  fi
  rm -rf "$VERIFY_ROOT"
}
trap cleanup EXIT

CONTENTS="$VERIFY_ROOT/contents.txt"
tar -tzf "$ARCHIVE" > "$CONTENTS"
if awk '
  $0 !~ /^bpa\// ||
  $0 ~ /(^|\/)\.\.(\/|$)/ ||
  $0 ~ /^\// { exit 1 }
' "$CONTENTS"; then
  :
else
  print -u2 "Archive contains an unsafe path."
  exit 1
fi
if grep -Eiq '(^|/)(CLAUDE\.md|SKILL\.md|\.env|id_rsa|id_ed25519)(/|$)|\.(pem|p12|key)$' "$CONTENTS"; then
  print -u2 "Archive contains a forbidden user, Skill, environment, or key file."
  exit 1
fi
if grep -Eiq '(^|/)(src|test|tests|node_modules/\.pnpm)(/|$)' "$CONTENTS"; then
  print -u2 "Archive contains source, tests, or a development dependency layout."
  exit 1
fi

tar -xzf "$ARCHIVE" -C "$VERIFY_ROOT"
PACKAGE_ROOT="$VERIFY_ROOT/bpa"
RUNTIME_ROOT="$PACKAGE_ROOT/runtime"
NODE="$RUNTIME_ROOT/node/bin/node"
"$NODE" "$RUNTIME_ROOT/bin/bpa-runtime-verify.js" "$RUNTIME_ROOT"
if [[ "$("$NODE" -p 'process.platform + ":" + process.arch + ":" + process.versions.node.split(".")[0]')" != "darwin:arm64:24" ]]; then
  print -u2 "Packaged Node identity is invalid."
  exit 1
fi
if [[ ! -f "$RUNTIME_ROOT/extension/manifest.json" ]]; then
  print -u2 "Packaged Extension manifest is missing."
  exit 1
fi

ISOLATED_HOME="$VERIFY_ROOT/bpa-home"
BPA_HOME="$ISOLATED_HOME" \
  "$NODE" "$RUNTIME_ROOT/bin/bpa-core.js" --migrate-only
BPA_HOME="$ISOLATED_HOME" \
  "$NODE" "$RUNTIME_ROOT/bin/bpa-core.js" \
  >"$VERIFY_ROOT/core.stdout.log" \
  2>"$VERIFY_ROOT/core.stderr.log" &
CORE_PID=$!
DOCTOR="$VERIFY_ROOT/doctor.json"
for _attempt in {1..50}; do
  if BPA_HOME="$ISOLATED_HOME" \
    "$NODE" "$RUNTIME_ROOT/bin/bpa.js" doctor >"$DOCTOR" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if ! "$NODE" --input-type=module -e '
  import { readFileSync } from "node:fs";
  const doctor = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (
    doctor.status !== "ok" ||
    doctor.persistence?.adapter !== "sqlite" ||
    doctor.persistence?.writable !== true
  ) process.exit(1);
' "$DOCTOR"; then
  print -u2 "Packaged Core health check failed."
  tail -50 "$VERIFY_ROOT/core.stderr.log" >&2
  exit 1
fi
kill "$CORE_PID"
wait "$CORE_PID"
CORE_PID=""

print "Verified packaged BPA runtime, migration, socket, CLI, and Extension closure."
