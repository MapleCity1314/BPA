#!/bin/zsh
set -euo pipefail

ROOT="/Users/Shared/ecom-profit/projects/InsightX"
PYTHON="/Users/Shared/ecom-profit/projects/ecom-profit-app/.venv/bin/python"
LOG_DIR="$ROOT/runtime/logs"
LOCK_DIR="$ROOT/runtime/locks/wdt-stockout-sync.lock"
mkdir -p "$LOG_DIR" "$ROOT/runtime/locks"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') SKIP: another WDT stockout sync is running" >>"$LOG_DIR/wdt_stockout_recent.log"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

"$PYTHON" "$ROOT/platforms/wdt/stockout_sync_runner.py" \
  --mode custom \
  --lookback-hours 2 \
  --chunk-hours 1 \
  --no-resume \
  >>"$LOG_DIR/wdt_stockout_recent.log" 2>&1
