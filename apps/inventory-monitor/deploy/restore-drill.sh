#!/bin/sh
set -eu

: "${BPA_PG_RESTORE_DSN:?BPA_PG_RESTORE_DSN is required}"
backup=${1:?usage: restore-drill.sh backup.dump}
test -r "$backup"
database=$(psql "$BPA_PG_RESTORE_DSN" -v ON_ERROR_STOP=1 -Atc 'SELECT current_database()')
case "$database" in
  bpa_app_restore_drill_*) ;;
  *) printf 'Refusing restore into non-drill database: %s\n' "$database" >&2; exit 64 ;;
esac
pg_restore --list "$backup" >/dev/null
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error \
  --dbname="$BPA_PG_RESTORE_DSN" "$backup"
psql "$BPA_PG_RESTORE_DSN" -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM control.schema_migration; SELECT count(*) FROM inventory.snapshot; SELECT count(*) FROM source.order_line_fact;"
