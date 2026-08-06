#!/bin/sh
set -eu

test "$(id -un)" = "yyerybz"

deploy_root="/Users/yyerybz/Codex/BPA"
runtime_root="/Users/yyerybz/Library/Application Support/BPA"
backup_root="$runtime_root/backups"
postgres_root="$backup_root/postgres"
extension_archive="$backup_root/deploy/extension/legacy-20260803"
offsite_old="/Users/yyerybz/Library/Mobile Documents/com~apple~CloudDocs/BPA Offsite Backups"
offsite_root="/Users/yyerybz/Library/Mobile Documents/com~apple~CloudDocs/BPA/Backups/PostgreSQL"
backup_env="$runtime_root/inventory-backup.env"

test -d "$deploy_root/apps/inventory-monitor"
test -r "$backup_env"
test "$(stat -f '%Lp' "$backup_env")" = "600"

mkdir -p "$postgres_root" "$extension_archive" "$offsite_root"
chmod 700 "$runtime_root" "$backup_root" "$postgres_root" "$backup_root/deploy" \
  "$backup_root/deploy/extension" "$extension_archive" "$offsite_root"

for source_name in daily weekly; do
  source_path="$backup_root/$source_name"
  target_path="$postgres_root/$source_name"
  if [ -d "$source_path" ]; then
    test ! -e "$target_path"
    mv "$source_path" "$target_path"
  fi
  mkdir -p "$target_path"
  chmod 700 "$target_path"
done

find /Users/yyerybz -maxdepth 1 -mindepth 1 -name 'BPA-extension*' -exec sh -c '
  destination=$1
  shift
  for source_path do
    target_path="$destination/$(basename "$source_path")"
    test ! -e "$target_path"
    mv "$source_path" "$target_path"
  done
' sh "$extension_archive" {} +

if [ -d "$offsite_old" ]; then
  find "$offsite_old" -maxdepth 1 -mindepth 1 -exec sh -c '
    destination=$1
    shift
    for source_path do
      target_path="$destination/$(basename "$source_path")"
      test ! -e "$target_path"
      mv "$source_path" "$target_path"
    done
  ' sh "$offsite_root" {} +
  rmdir "$offsite_old"
fi

test "$(grep -c '^BPA_PG_BACKUP_DIR=' "$backup_env")" = "1"
test "$(grep -c '^BPA_PG_OFFSITE_DIR=' "$backup_env")" = "1"
/usr/bin/sed -i '' \
  "s|^BPA_PG_BACKUP_DIR=.*|BPA_PG_BACKUP_DIR='$postgres_root'|" "$backup_env"
/usr/bin/sed -i '' \
  "s|^BPA_PG_OFFSITE_DIR=.*|BPA_PG_OFFSITE_DIR='$offsite_root'|" "$backup_env"
chmod 600 "$backup_env"

test "$(find /Users/yyerybz -maxdepth 1 -mindepth 1 -name 'BPA-extension*' -print | wc -l | tr -d ' ')" = "0"
test ! -e "$backup_root/daily"
test ! -e "$backup_root/weekly"
test -d "$postgres_root/daily"
test -d "$postgres_root/weekly"
test ! -e "$offsite_old"

printf 'BPA production layout migration completed\n'
