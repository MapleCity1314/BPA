#!/bin/sh
set -eu

env_file=${1:?environment file is required}
component=${2:?component is required}
test -r "$env_file"
mode=$(stat -f '%Lp' "$env_file")
test "$mode" = "600"
set -a
. "$env_file"
set +a
: "${BPA_NODE_BIN:?BPA_NODE_BIN is required}"
: "${BPA_REPOSITORY_ROOT:?BPA_REPOSITORY_ROOT is required}"
test "$("$BPA_NODE_BIN" --version)" = "v24.18.0"
cd "$BPA_REPOSITORY_ROOT"

case "$component" in
  core)
    exec "$BPA_NODE_BIN" --import tsx apps/local-core/src/main.ts
    ;;
  service)
    exec "$BPA_NODE_BIN" --import tsx apps/inventory-monitor/src/main.ts
    ;;
  scheduler)
    exec "$BPA_NODE_BIN" --import tsx apps/inventory-monitor/src/scheduler-main.ts
    ;;
  migrate)
    exec "$BPA_NODE_BIN" --import tsx apps/inventory-monitor/src/migrate-main.ts
    ;;
  *)
    printf 'Unknown component: %s\n' "$component" >&2
    exit 64
    ;;
esac
