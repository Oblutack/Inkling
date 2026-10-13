# Backups and restoring

Everything Inkling keeps (accounts, summaries, the text behind them, stored PDFs and recordings, API keys) lives in **one
PostgreSQL database**. Back that up and you have backed up the product. The AI service keeps nothing, and the frontend
keeps nothing but a language and theme choice in each person's browser.

The app itself does **not** make backups, but the repository has the scripts to make and check them (below). They take
minutes to set up; a schedule that runs them is yours to choose. The "download my data" button in the account page is for one person to take
their own data with them: it is not a backup of the site.

## The scripts

| Script | What it does |
| --- | --- |
| `scripts/backup-db.sh` | Dumps the database, **reads the dump back** to be sure it is complete, optionally encrypts it, and tidies old ones (the newest 7, plus the first of each of the last 6 months). Exits with an error if anything fails, leaving no half-written file. |
| `scripts/restore-check.sh <file>` | Restores a backup into a scratch database, prints the number of rows in the main tables, and removes the scratch database. The real database is not touched. |

```bash
scripts/backup-db.sh                                   # the database of the docker compose stack
DATABASE_URL='postgres://user:pass@host:5432/db?sslmode=require' scripts/backup-db.sh   # any other (needs pg_dump and pg_restore)
BACKUP_PASSPHRASE_FILE=~/inkling-backup.pass scripts/backup-db.sh                       # encrypted (gpg, or openssl if there is no gpg)
scripts/restore-check.sh backups/inkling-2026-10-13_022042.dump
```

Backups go to `backups/` (ignored by git); `BACKUP_DIR`, `BACKUP_KEEP_DAILY` and `BACKUP_KEEP_MONTHLY` change that. Keep the
passphrase file somewhere else than the backups, and copy the backups to a place that is not the same machine or account.

### Running them every day

- **Linux or a small server (cron):** `0 3 * * * cd /path/to/inkling && BACKUP_PASSPHRASE_FILE=/path/pass scripts/backup-db.sh >> backups/backup.log 2>&1`
- **Windows (Task Scheduler):** an action that runs `"C:\Program Files\Git\bin\bash.exe" -lc "cd '/c/path/to/inkling' && scripts/backup-db.sh"`, daily, with
  "Run task as soon as possible after a scheduled start is missed" ticked (Docker Desktop must be running).
- **A hosted database:** run it from a scheduled GitHub Action with `DATABASE_URL` and the passphrase as repository secrets, and
  upload the encrypted file to storage you own. Only the encrypted file may leave the job.

A scheduler only helps if someone hears about a failure: have it mail you on a non-zero exit, or check that the newest file in
`backups/` is less than two days old.

## What to do

1. **Use your database host's backups if it has them, and check the details.** Neon has point-in-time restore (the
   window depends on the plan); Render's free database is deleted after 30 days and has no backups at all; paid Render
   databases keep daily backups. "Has backups" and "backups I have actually restored" are different things: do step 3.
2. **Also take your own dumps, somewhere else.** A host can lose an account as easily as a database. Once a day is
   enough to start with:

   ```bash
   # DATABASE_URL looks like: postgres://user:password@host:5432/dbname?sslmode=require
   pg_dump "$DATABASE_URL" --format=custom --no-owner --file "inkling-$(date +%F).dump"
   ```

   Keep the last 7 daily dumps and a monthly one, in a different place from the database (another account or provider).
   A dump contains every summary and every stored file in the clear, so **encrypt it** before it leaves your machine:

   ```bash
   gpg --symmetric --cipher-algo AES256 inkling-2026-10-10.dump      # asks for a passphrase; keep that safe too
   # or, with age:   age -p -o inkling-2026-10-10.dump.age inkling-2026-10-10.dump
   ```

   Run it from a scheduler you trust (above), and have it tell you when it fails.
3. **Try restoring, before you need to.** A backup nobody has restored is a hope. Into a scratch database:

   ```bash
   createdb inkling_restore_check
   pg_restore --no-owner --dbname inkling_restore_check inkling-2026-10-10.dump
   psql inkling_restore_check -c "SELECT count(*) FROM users"      # a sensible number?
   dropdb inkling_restore_check
   ```

   Do this once now and again after any big change to the schema. It should take minutes.

## If you have to restore for real

1. Stop the API (so nothing writes while you restore).
2. Restore into an empty database with `pg_restore --no-owner --clean --if-exists --dbname "$DATABASE_URL" <dump>` (decrypt it first).
3. Start the API. It applies any migrations the dump is missing, so a dump from an older version is fine.
4. Everyone will have to sign in again if the dump is older than their last login; nothing else is lost but what happened
   after the dump.

## What a backup does not hold

- **The secrets** (`GROQ_API_KEY`, `AI_SERVICE_TOKEN`, `GOOGLE_CLIENT_ID`, mail keys, `TURNSTILE_SECRET`, `IP_HASH_KEY`):
  they are environment variables, not data. Keep them in a password manager so a rebuilt server can be configured. If a
  dump or its passphrase may have leaked, rotate them and make everyone sign in again.
- **Anything in the browser**, such as a person's unsent draft.

## Check your connection is encrypted

The dumps and the app both talk to the database over the network. Use `sslmode=require` (or `verify-full`) in every
connection string that is not on the same machine; the API warns at start-up if it finds `sslmode=disable` pointing at a
remote database.
