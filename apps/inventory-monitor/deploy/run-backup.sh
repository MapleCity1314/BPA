#!/bin/sh
set -eu

env_file=${1:?backup environment file is required}
test -r "$env_file"
test "$(stat -f '%Lp' "$env_file")" = "600"
set -a
. "$env_file"
set +a
: "${BPA_REPOSITORY_ROOT:?BPA_REPOSITORY_ROOT is required}"
exec "$BPA_REPOSITORY_ROOT/apps/inventory-monitor/deploy/backup.sh"
