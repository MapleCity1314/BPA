#!/bin/sh

# The Mac mini production layout is intentionally fixed. Keeping these paths in
# one file prevents launchd jobs, manual recovery commands, and backup tooling
# from slowly drifting back into the account home directory.
BPA_PRODUCTION_DEPLOY_ROOT="/Users/yyerybz/Codex/BPA"
BPA_PRODUCTION_RUNTIME_ROOT="/Users/yyerybz/Library/Application Support/BPA"
BPA_PRODUCTION_BACKUP_ROOT="$BPA_PRODUCTION_RUNTIME_ROOT/backups"
BPA_PRODUCTION_PG_BACKUP_ROOT="$BPA_PRODUCTION_BACKUP_ROOT/postgres"
BPA_PRODUCTION_OFFSITE_ROOT="/Users/yyerybz/Library/Mobile Documents/com~apple~CloudDocs/BPA/Backups/PostgreSQL"

bpa_assert_production_root() {
  actual_root=${BPA_REPOSITORY_ROOT:-}
  if [ "$actual_root" != "$BPA_PRODUCTION_DEPLOY_ROOT" ]; then
    printf 'BPA production repository root mismatch\n' >&2
    return 1
  fi
  if [ ! -d "$BPA_PRODUCTION_DEPLOY_ROOT/apps/inventory-monitor" ]; then
    printf 'BPA production application directory is unavailable\n' >&2
    return 1
  fi
}

bpa_assert_backup_layout() {
  bpa_assert_production_root
  if [ "${BPA_RUNTIME_ROOT:-}" != "$BPA_PRODUCTION_RUNTIME_ROOT" ] ||
     [ "${BPA_PG_BACKUP_DIR:-}" != "$BPA_PRODUCTION_PG_BACKUP_ROOT" ] ||
     [ "${BPA_PG_OFFSITE_DIR:-}" != "$BPA_PRODUCTION_OFFSITE_ROOT" ]; then
    printf 'BPA production backup layout mismatch\n' >&2
    return 1
  fi
}
