#!/bin/sh
set -eu

: "${BPA_PG_BACKUP_DIR:?BPA_PG_BACKUP_DIR is required}"
: "${BPA_PG_BACKUP_DSN_FILE:?BPA_PG_BACKUP_DSN_FILE is required}"
: "${BPA_PG_OFFSITE_DIR:?BPA_PG_OFFSITE_DIR is required}"
: "${BPA_BACKUP_AGE_RECIPIENT:?BPA_BACKUP_AGE_RECIPIENT is required}"
: "${BPA_RUNTIME_ROOT:?BPA_RUNTIME_ROOT is required}"

umask 077
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
daily_dir="$BPA_PG_BACKUP_DIR/daily"
weekly_dir="$BPA_PG_BACKUP_DIR/weekly"
output="$daily_dir/bpa_app-$timestamp.dump"
checksum="$output.sha256"
partial="$daily_dir/.bpa_app-$timestamp.dump.partial.$$"
offsite_output="$BPA_PG_OFFSITE_DIR/$(basename "$output").age"
lock_dir="$BPA_RUNTIME_ROOT/run/postgres-backup.lock"
pg_bin_dir=${BPA_PG_BIN_DIR:-/opt/homebrew/opt/postgresql@18/bin}
age_bin=${BPA_AGE_BIN:-$(command -v age 2>/dev/null || true)}

mkdir -p "$BPA_RUNTIME_ROOT/run" "$daily_dir" "$weekly_dir" "$BPA_PG_OFFSITE_DIR"
chmod 700 "$BPA_RUNTIME_ROOT/run" "$BPA_PG_BACKUP_DIR" "$daily_dir" "$weekly_dir" "$BPA_PG_OFFSITE_DIR"

if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_pid=$(sed -n '1p' "$lock_dir/pid" 2>/dev/null || true)
  case "$lock_pid" in
    ''|*[!0-9]*) lock_pid= ;;
  esac
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    printf 'BPA PostgreSQL backup skipped: another backup is running\n'
    exit 0
  fi
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir"
  mkdir "$lock_dir"
fi
printf '%s\n' "$$" >"$lock_dir/pid"

cleanup() {
  rm -f "$partial"
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

if [ ! -x "$pg_bin_dir/pg_dump" ] || [ ! -x "$pg_bin_dir/pg_restore" ]; then
  printf 'BPA PostgreSQL backup tools are unavailable\n' >&2
  exit 1
fi
if [ -z "$age_bin" ] || [ ! -x "$age_bin" ]; then
  printf 'BPA age encryption tool is unavailable\n' >&2
  exit 1
fi
dsn=$(sed -n '1p' "$BPA_PG_BACKUP_DSN_FILE")
test -n "$dsn"
"$pg_bin_dir/pg_dump" --format=custom --no-owner --no-acl --dbname="$dsn" --file="$partial"
test -s "$partial"
"$pg_bin_dir/pg_restore" --list "$partial" >/dev/null
mv "$partial" "$output"
(
  cd "$daily_dir"
  shasum -a 256 "$(basename "$output")" >"$(basename "$checksum")"
)
if [ "$(date -u +%u)" = "7" ]; then
  cp -p "$output" "$weekly_dir/$(basename "$output")"
  cp -p "$checksum" "$weekly_dir/$(basename "$checksum")"
fi
# iCloud Drive's File Provider permits a launchd job to create a unique file but
# rejects an in-directory rename. The timestamped destination is never reused,
# so age writes it once and its successful exit is the publication boundary.
"$age_bin" --recipient "$BPA_BACKUP_AGE_RECIPIENT" --output "$offsite_output" "$output"
test -s "$offsite_output"
find "$daily_dir" -type f \( -name 'bpa_app-*.dump' -o -name 'bpa_app-*.dump.sha256' \) -mtime +14 -delete
find "$weekly_dir" -type f \( -name 'bpa_app-*.dump' -o -name 'bpa_app-*.dump.sha256' \) -mtime +56 -delete
printf '%s\n' "$output"
