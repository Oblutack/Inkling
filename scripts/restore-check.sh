#!/usr/bin/env bash
# Proves that a backup can be restored: loads it into a throw-away database next to the real one, counts the rows of the
# main tables, and removes the scratch database again. The real database is not touched.
#
#   scripts/restore-check.sh backups/inkling-2026-10-13_022042.dump
#   BACKUP_PASSPHRASE_FILE=pass.txt scripts/restore-check.sh backups/inkling-2026-10-13_022043.dump.gpg
#
# It works on the docker compose stack's database (BACKUP_DB_CONTAINER, default summarizer-db). For another server do the
# same by hand, as docs/BACKUPS.md describes.
set -euo pipefail

file="${1:?usage: scripts/restore-check.sh <backup file>}"
container="${BACKUP_DB_CONTAINER:-summarizer-db}"
scratch="inkling_restore_check"

if ! command -v docker >/dev/null 2>&1 && [ -d "/c/Program Files/Docker/Docker/resources/bin" ]; then
  PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
fi

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
  docker exec "$container" sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists $scratch" >/dev/null 2>&1 || true
}
trap cleanup EXIT

case "$file" in
  *.gpg)
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE to open an encrypted backup}" \
      --decrypt --output "$tmp/backup.dump" "$file" ;;
  *.enc)
    openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:${BACKUP_PASSPHRASE_FILE:?set BACKUP_PASSPHRASE_FILE to open an encrypted backup}" \
      -in "$file" -out "$tmp/backup.dump" ;;
  *) cp "$file" "$tmp/backup.dump" ;;
esac

docker exec "$container" sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists $scratch && createdb -U \"\$POSTGRES_USER\" $scratch"
docker exec -i "$container" sh -c "pg_restore -U \"\$POSTGRES_USER\" --no-owner --dbname $scratch" <"$tmp/backup.dump"

echo "restored into a scratch database; rows per table:"
for table in users documents document_passages document_files api_keys sessions; do
  count="$(docker exec "$container" sh -c "psql -U \"\$POSTGRES_USER\" -d $scratch -Atc 'SELECT count(*) FROM $table'")"
  printf '  %-18s %s\n' "$table" "$count"
done
echo "ok: the backup can be restored (scratch database removed)"
