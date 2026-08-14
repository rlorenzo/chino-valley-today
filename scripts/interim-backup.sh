#!/usr/bin/env bash
# Interim backup of the gitignored state that the 2026-08-13 reinstall wipe
# proved has no safety net: data/ (SQLite DB + content-addressed raw archive),
# .env (secrets — the backup dir is chmod 700), and pipeline working state
# under content/ (queue/held/rejected; published/ is git-tracked).
#
#   npm run backup            -> ~/Backups/chino-valley-today/<YYYY-MM-DD>/
#   CVT_BACKUP_DIR=<dir> ...  -> <dir>/<YYYY-MM-DD>/  (point at a mounted or
#                                cloud-synced folder to get offsite for free)
#
# Same-day re-runs overwrite that day's snapshot; older days accumulate until
# pruned by hand. This is a stopgap until Phase 2's proper nightly job
# (sqlite3 .backup + tar to DO Spaces or restic).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${CVT_BACKUP_DIR:-$HOME/Backups/chino-valley-today}"
DEST="$BASE/$(date +%Y-%m-%d)"

mkdir -p "$DEST"
chmod 700 "$BASE" "$DEST"

# Live-safe DB copy (WAL-aware), then verify the copy is a sane database.
sqlite3 "$ROOT/data/cvtoday.db" ".backup '$DEST/cvtoday.db'"
CHECK="$(sqlite3 "$DEST/cvtoday.db" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "FATAL: integrity_check on backup copy returned: $CHECK" >&2
  exit 1
fi

tar -czf "$DEST/raw.tar.gz" -C "$ROOT/data" raw
tar -czf "$DEST/content.tar.gz" -C "$ROOT" content
if [ -f "$ROOT/.env" ]; then
  cp "$ROOT/.env" "$DEST/env"
  chmod 600 "$DEST/env"
fi

ITEMS="$(sqlite3 "$DEST/cvtoday.db" 'SELECT COUNT(*) FROM items;')"
POSTS="$(sqlite3 "$DEST/cvtoday.db" 'SELECT COUNT(*) FROM posts;')"
# The verification reads leave empty WAL sidecars on the copy; drop them.
rm -f "$DEST/cvtoday.db-shm" "$DEST/cvtoday.db-wal"
echo "Backup OK -> $DEST"
echo "  db: integrity ok, $ITEMS items, $POSTS posts"
du -sh "$DEST"/* | sed 's/^/  /'
