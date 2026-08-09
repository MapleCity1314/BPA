#!/bin/zsh
set -euo pipefail

readonly BPA_PROJECT_ROOT="/Users/yyerybz/Codex/BPA"
export BPA_RUNTIME_ROOT="$HOME/Library/Application Support/BPA"
readonly BPA_CORE_ENV="$BPA_RUNTIME_ROOT/core.env"
readonly BPA_RECOVERY_ENV="$BPA_RUNTIME_ROOT/inventory-multishop-recovery.env"

if [[ ! -r "$BPA_CORE_ENV" || ! -r "$BPA_RECOVERY_ENV" ]]; then
  print -u2 "BPA inventory production configuration is unavailable"
  exit 1
fi
if [[ "$(stat -f '%Lp' "$BPA_CORE_ENV")" != "600" ||
      "$(stat -f '%Lp' "$BPA_RECOVERY_ENV")" != "600" ]]; then
  print -u2 "BPA inventory production configuration permissions are invalid"
  exit 1
fi

cd "$BPA_PROJECT_ROOT"
set -a
source "$BPA_CORE_ENV"
source "$BPA_RECOVERY_ENV"
set +a
export BPA_RUNTIME_ROOT
: "${BPA_NODE_BIN:?BPA_NODE_BIN is required}"
if [[ "$($BPA_NODE_BIN --version)" != "v24.18.0" ]]; then
  print -u2 "BPA inventory production requires Node.js 24.18.0"
  exit 1
fi

exec "$BPA_NODE_BIN" --import tsx \
  apps/inventory-monitor/src/production-readiness-main.ts
