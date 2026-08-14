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
# Same-day re-runs replace that day's snapshot; older days accumulate until
# pruned by hand. The replacement is staged: everything is built in a sibling
# .partial dir and only swapped into place once every step has succeeded, so a
# failed or interrupted re-run leaves the previous good snapshot intact rather
# than half-overwriting it (and a since-deleted .env can't leave a stale copy
# behind). This is a stopgap until Phase 2's proper nightly job
# (sqlite3 .backup + tar to DO Spaces or restic).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${CVT_BACKUP_DIR:-$HOME/Backups/chino-valley-today}"
DEST="$BASE/$(date +%Y-%m-%d)"
STAGE="$DEST.partial.$$"

mkdir -p "$STAGE"
chmod 700 "$BASE" "$STAGE"
# Any non-zero exit (set -e), signal, or explicit failure below discards the
# half-built staging dir and leaves $DEST untouched.
trap 'rm -rf "$STAGE"' EXIT

# SIGKILL can't be trapped, so a hard-killed run strands its staging dir (~80MB
# of raw archive each). Sweep any that are no longer owned by a live process.
for stale in "$BASE"/*.partial.*; do
  [ -d "$stale" ] || continue
  [ "$stale" = "$STAGE" ] && continue
  stalepid="${stale##*.}"
  kill -0 "$stalepid" 2>/dev/null || rm -rf "$stale"
done

# Live-safe DB copy (WAL-aware), then verify the copy is a sane database.
sqlite3 "$ROOT/data/cvtoday.db" ".backup '$STAGE/cvtoday.db'"
CHECK="$(sqlite3 "$STAGE/cvtoday.db" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "FATAL: integrity_check on backup copy returned: $CHECK" >&2
  exit 1
fi

tar -czf "$STAGE/raw.tar.gz" -C "$ROOT/data" raw
tar -czf "$STAGE/content.tar.gz" -C "$ROOT" content
if [ -f "$ROOT/.env" ]; then
  cp "$ROOT/.env" "$STAGE/env"
  chmod 600 "$STAGE/env"
fi

ITEMS="$(sqlite3 "$STAGE/cvtoday.db" 'SELECT COUNT(*) FROM items;')"
POSTS="$(sqlite3 "$STAGE/cvtoday.db" 'SELECT COUNT(*) FROM posts;')"
# The verification reads leave empty WAL sidecars on the copy; drop them.
rm -f "$STAGE/cvtoday.db-shm" "$STAGE/cvtoday.db-wal"

# Everything succeeded — swap the finished snapshot in. The old copy is moved
# aside rather than deleted first, so the window in which neither exists is a
# single rename.
if [ -d "$DEST" ]; then
  rm -rf "$DEST.superseded"
  mv "$DEST" "$DEST.superseded"
fi
mv "$STAGE" "$DEST"
rm -rf "$DEST.superseded"
trap - EXIT

echo "Backup OK -> $DEST"
echo "  db: integrity ok, $ITEMS items, $POSTS posts"
du -sh "$DEST"/* | sed 's/^/  /'
