#!/bin/sh
set -eu

env_file=${1:?backup environment file is required}
test -r "$env_file"
test "$(stat -f '%Lp' "$env_file")" = "600"
set -a
. "$env_file"
set +a
: "${BPA_REPOSITORY_ROOT:?BPA_REPOSITORY_ROOT is required}"
. "$BPA_REPOSITORY_ROOT/apps/inventory-monitor/deploy/production-layout.sh"
: "${BPA_RUNTIME_ROOT:=$BPA_PRODUCTION_RUNTIME_ROOT}"
export BPA_RUNTIME_ROOT
bpa_assert_backup_layout
exec "$BPA_REPOSITORY_ROOT/apps/inventory-monitor/deploy/backup.sh"
