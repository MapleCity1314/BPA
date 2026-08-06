#!/bin/zsh
set -euo pipefail

readonly BPA_PROJECT_ROOT="/Users/yyerybz/Codex/BPA"
readonly BPA_RUNTIME_ROOT="$HOME/Library/Application Support/BPA"
readonly BPA_CORE_ENV="$BPA_RUNTIME_ROOT/core.env"
readonly BPA_SCHEDULER_ENV="$BPA_RUNTIME_ROOT/inventory-scheduler.env"

if [[ ! -r "$BPA_CORE_ENV" || ! -r "$BPA_SCHEDULER_ENV" ]]; then
  print -u2 "BPA inventory recovery configuration is unavailable"
  exit 1
fi

cd "$BPA_PROJECT_ROOT"
set -a
source "$BPA_CORE_ENV"
source "$BPA_SCHEDULER_ENV"
set +a

export BPA_INVENTORY_SCOPE_MODE="${BPA_INVENTORY_SCOPE_MODE:-persisted}"
export BPA_INVENTORY_REFRESH_SINCE="$(date -u -v-45M +%Y-%m-%dT%H:%M:%SZ)"
unset BPA_INVENTORY_PRODUCT_IDS

set +e
"$BPA_NODE_BIN" --import tsx apps/inventory-monitor/src/refresh-recent.ts
readonly recent_status=$?
if (( recent_status != 0 )); then
  print -u2 "BPA recent-order refresh degraded with status $recent_status; inventory collection will continue"
fi

"$BPA_NODE_BIN" --import tsx apps/inventory-monitor/src/refresh-missing.ts
readonly collection_status=$?
set -e

if (( collection_status != 0 && collection_status != 2 )); then
  print -u2 "BPA inventory recovery collection stopped with status $collection_status"
  exit "$collection_status"
fi

"$BPA_NODE_BIN" --import tsx apps/inventory-monitor/src/refresh-risk.ts
