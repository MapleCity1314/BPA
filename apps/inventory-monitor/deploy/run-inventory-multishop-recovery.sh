#!/bin/zsh
set -euo pipefail

readonly BPA_PROJECT_ROOT="/Users/yyerybz/Codex/BPA"
export BPA_RUNTIME_ROOT="$HOME/Library/Application Support/BPA"
readonly BPA_CORE_ENV="$BPA_RUNTIME_ROOT/core.env"
readonly BPA_SCHEDULER_ENV="$BPA_RUNTIME_ROOT/inventory-scheduler.env"

if [[ ! -r "$BPA_CORE_ENV" || ! -r "$BPA_SCHEDULER_ENV" ]]; then
  print -u2 "BPA inventory production configuration is unavailable"
  exit 1
fi

cd "$BPA_PROJECT_ROOT"
set -a
source "$BPA_CORE_ENV"
source "$BPA_SCHEDULER_ENV"
set +a
export BPA_RUNTIME_ROOT
export BPA_INVENTORY_TRIGGER_KIND="${BPA_INVENTORY_TRIGGER_KIND:-schedule}"
unset BPA_INVENTORY_PRODUCT_IDS

exec "$BPA_NODE_BIN" --import tsx \
  apps/inventory-monitor/src/production-cycle.ts
