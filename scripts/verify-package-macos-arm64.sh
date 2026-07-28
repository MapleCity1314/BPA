#!/bin/zsh
set -euo pipefail

ARCHIVE="${1:A}"
if [[ ! -f "$ARCHIVE" ]]; then
  print -u2 "Usage: $0 /absolute/path/to/bpa-local-<version>-macos-arm64.tar.gz"
  exit 1
fi
CHECKSUM="$ARCHIVE.sha256"
if [[ ! -f "$CHECKSUM" ]]; then
  print -u2 "Release checksum sidecar is missing; legacy archives are not installable."
  exit 1
fi
if [[ "$(wc -l < "$CHECKSUM" | tr -d ' ')" != "1" ]]; then
  print -u2 "Release checksum sidecar must contain exactly one entry."
  exit 1
fi
EXPECTED_HASH="$(awk '{print $1}' "$CHECKSUM")"
EXPECTED_NAME="$(awk '{print $2}' "$CHECKSUM")"
ACTUAL_HASH="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if ! print -n "$EXPECTED_HASH" | grep -Eq '^[a-f0-9]{64}$' ||
    [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ||
      "$EXPECTED_NAME" != "${ARCHIVE:t}" ]]; then
  print -u2 "Release checksum or checksum filename does not match the archive."
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
MANIFEST_NODE_VERSION="$(
  "$NODE" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.stdout.write(manifest.release.nodeVersion);
  ' "$RUNTIME_ROOT/runtime-manifest.json"
)"
if [[ "$("$NODE" -p 'process.platform + ":" + process.arch + ":" + process.versions.node')" != \
      "darwin:arm64:$MANIFEST_NODE_VERSION" ]]; then
  print -u2 "Packaged Node identity is invalid."
  exit 1
fi
"$NODE" "$RUNTIME_ROOT/bin/bpa-release-scan.js" "$PACKAGE_ROOT"
RELEASE_IDENTITY="$(
  "$NODE" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.stdout.write(manifest.release.identity);
  ' "$RUNTIME_ROOT/runtime-manifest.json"
)"
EXPECTED_ARCHIVE="bpa-local-${RELEASE_IDENTITY}-macos-arm64.tar.gz"
if [[ "${ARCHIVE:t}" != "$EXPECTED_ARCHIVE" ]]; then
  print -u2 "Release filename does not match its manifest: expected $EXPECTED_ARCHIVE."
  print -u2 "Legacy artifacts are explicitly rejected."
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
TEAM_NODE="$RUNTIME_ROOT/assets/nodes/packaging.products.normalize.node.yaml"
if [[ ! -f "$TEAM_NODE" ]]; then
  print -u2 "Packaged Team Node asset is missing."
  exit 1
fi
BPA_HOME="$ISOLATED_HOME" \
  "$NODE" "$RUNTIME_ROOT/bin/bpa.js" publish node "$TEAM_NODE" --yes \
  >"$VERIFY_ROOT/team-publish.json"
BPA_HOME="$ISOLATED_HOME" \
  "$NODE" "$RUNTIME_ROOT/bin/bpa.js" run-node packaging.products.normalize \
  --version 1.0.0 \
  --input '{"shopId":"shop-package-test","products":[{"id":"10001","title":"Package Worker Test","editorUrl":"https://fxg.jinritemai.com/ffa/g/create?product_id=10001"}]}' \
  >"$VERIFY_ROOT/team-run.json"
TEAM_RUN_ID="$(
  "$NODE" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const response = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (
      response.preview?.riskLevel !== "R0" ||
      response.preview?.requiresConfirmation !== false ||
      typeof response.run?.id !== "string"
    ) process.exit(1);
    process.stdout.write(response.run.id);
  ' "$VERIFY_ROOT/team-run.json"
)"
for _attempt in {1..50}; do
  BPA_HOME="$ISOLATED_HOME" \
    "$NODE" "$RUNTIME_ROOT/bin/bpa.js" inspect "$TEAM_RUN_ID" \
    >"$VERIFY_ROOT/team-inspect.json"
  TEAM_STATUS="$(
    "$NODE" --input-type=module -e '
      import { readFileSync } from "node:fs";
      const run = JSON.parse(readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(run.status));
    ' "$VERIFY_ROOT/team-inspect.json"
  )"
  [[ "$TEAM_STATUS" == "succeeded" ]] && break
  [[ "$TEAM_STATUS" == "failed" || "$TEAM_STATUS" == "uncertain" ]] && break
  sleep 0.1
done
if ! "$NODE" --input-type=module -e '
  import { readFileSync } from "node:fs";
  const run = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const product = run.output?.products?.[0];
  if (
    run.status !== "succeeded" ||
    product?.shopId !== "shop-package-test" ||
    product?.productId !== "10001"
  ) process.exit(1);
' "$VERIFY_ROOT/team-inspect.json"; then
  print -u2 "Packaged Team Worker invocation failed."
  tail -50 "$VERIFY_ROOT/core.stderr.log" >&2
  exit 1
fi
kill "$CORE_PID"
wait "$CORE_PID"
CORE_PID=""

print "Verified packaged BPA runtime, migration, socket, CLI, Team Worker, and Extension closure."
