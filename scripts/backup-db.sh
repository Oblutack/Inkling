#!/usr/bin/env bash
# Takes a backup of the Inkling database, checks that it can be read back, and tidies up old ones.
#
#   scripts/backup-db.sh                  # the database of the docker compose stack in this folder
#   DATABASE_URL=postgres://... scripts/backup-db.sh    # any other database (needs pg_dump and pg_restore installed)
#
# Settings (environment variables, all optional):
#   BACKUP_DIR              where the files go (default: ./backups, which git ignores)
#   BACKUP_KEEP_DAILY       how many daily backups to keep (default 7)
#   BACKUP_KEEP_MONTHLY     how many monthly ones to keep, the first backup of each month (default 6)
#   BACKUP_PASSPHRASE_FILE  a file holding a passphrase: the backup is then encrypted (gpg if installed, else openssl)
#                           before it is kept. A dump holds every summary in the clear, so do this for anything that
#                           leaves your machine. Keep the passphrase somewhere else than the backups.
#   BACKUP_DB_CONTAINER     the database container of the compose stack (default: summarizer-db)
#
# It exits with a non-zero status if anything failed, so a scheduler can tell you.
set -euo pipefail

cd "$(dirname "$0")/.."

dir="${BACKUP_DIR:-backups}"
keep_daily="${BACKUP_KEEP_DAILY:-7}"
keep_monthly="${BACKUP_KEEP_MONTHLY:-6}"
container="${BACKUP_DB_CONTAINER:-summarizer-db}"
stamp="$(date +%Y-%m-%d_%H%M%S)"
mkdir -p "$dir"

dump="$dir/inkling-$stamp.dump"
partial="$dump.partial"
trap 'rm -f "$partial"' EXIT

# Docker Desktop on Windows keeps its programs where Git Bash does not look.
if ! command -v docker >/dev/null 2>&1 && [ -d "/c/Program Files/Docker/Docker/resources/bin" ]; then
  PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"
fi

if [ -n "${DATABASE_URL:-}" ]; then
  dump_cmd() { pg_dump "$DATABASE_URL" --format=custom --no-owner; }
  list_cmd() { pg_restore --list; }
else
  # The container knows its own user and database name, so no password or address is needed here.
  dump_cmd() { docker exec "$container" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner'; }
  list_cmd() { docker exec -i "$container" pg_restore --list; }
fi

echo "backing up to $dump"
dump_cmd >"$partial"

# A backup nobody has read back is a hope: make sure the file is a complete dump with the tables in it.
size="$(wc -c <"$partial" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "backup failed: the dump is only $size bytes" >&2
  exit 1
fi
contents="$(list_cmd <"$partial")"
for table in users documents; do
  if ! grep -Eq "TABLE .* $table( |$)" <<<"$contents"; then
    echo "backup failed: the dump has no table '$table'" >&2
    exit 1
  fi
done
mv "$partial" "$dump"

if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "backup failed: $BACKUP_PASSPHRASE_FILE is missing or empty" >&2; exit 1; }
  if command -v gpg >/dev/null 2>&1; then
    gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 \
      --passphrase-file "$BACKUP_PASSPHRASE_FILE" --output "$dump.gpg" "$dump"
    final="$dump.gpg"
  else
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$dump" -out "$dump.enc"
    final="$dump.enc"
  fi
  rm -f "$dump"
else
  final="$dump"
  echo "note: not encrypted (set BACKUP_PASSPHRASE_FILE before this leaves your machine)" >&2
fi
echo "kept $final ($size bytes of dump)"

# Tidy up: the newest $keep_daily files, plus the first file of each of the last $keep_monthly months.
mapfile -t files < <(ls -1 "$dir" | grep -E '^inkling-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}\.dump(\.gpg|\.enc)?$' | sort -r)
declare -A keep=()
for ((i = 0; i < ${#files[@]} && i < keep_daily; i++)); do keep["${files[$i]}"]=1; done
declare -A seen=()
for ((i = ${#files[@]} - 1; i >= 0; i--)); do # oldest first: the first file seen of a month is that month's
  month="${files[$i]:8:7}"
  [ -n "${seen[$month]:-}" ] && continue
  seen[$month]=1
done
# the newest months, by their first file
for month in $(printf '%s\n' "${!seen[@]}" | sort -r | head -n "$keep_monthly"); do
  first="$(printf '%s\n' "${files[@]}" | grep "^inkling-$month" | sort | head -n 1)"
  keep["$first"]=1
done
removed=0
for f in "${files[@]}"; do
  if [ -z "${keep[$f]:-}" ]; then
    rm -f "$dir/$f"
    removed=$((removed + 1))
  fi
done
echo "tidied: $removed old backup(s) removed, ${#keep[@]} kept"
