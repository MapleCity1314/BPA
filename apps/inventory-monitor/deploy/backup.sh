#!/bin/sh
set -eu

: "${BPA_PG_BACKUP_DIR:?BPA_PG_BACKUP_DIR is required}"
: "${BPA_PG_BACKUP_DSN_FILE:?BPA_PG_BACKUP_DSN_FILE is required}"
: "${BPA_PG_OFFSITE_DIR:?BPA_PG_OFFSITE_DIR is required}"
: "${BPA_BACKUP_AGE_RECIPIENT:?BPA_BACKUP_AGE_RECIPIENT is required}"

umask 077
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
daily_dir="$BPA_PG_BACKUP_DIR/daily"
weekly_dir="$BPA_PG_BACKUP_DIR/weekly"
output="$daily_dir/bpa_app-$timestamp.dump"
mkdir -p "$daily_dir" "$weekly_dir" "$BPA_PG_OFFSITE_DIR"
dsn=$(sed -n '1p' "$BPA_PG_BACKUP_DSN_FILE")
test -n "$dsn"
pg_dump --format=custom --no-owner --no-acl --dbname="$dsn" --file="$output"
pg_restore --list "$output" >/dev/null
if [ "$(date -u +%u)" = "7" ]; then
  cp -p "$output" "$weekly_dir/$(basename "$output")"
fi
command -v age >/dev/null 2>&1
age --recipient "$BPA_BACKUP_AGE_RECIPIENT" --output "$BPA_PG_OFFSITE_DIR/$(basename "$output").age" "$output"
find "$daily_dir" -type f -name 'bpa_app-*.dump' -mtime +14 -delete
find "$weekly_dir" -type f -name 'bpa_app-*.dump' -mtime +56 -delete
find "$BPA_PG_OFFSITE_DIR" -type f -name 'bpa_app-*.dump.age' -mtime +56 -delete
printf '%s\n' "$output"
