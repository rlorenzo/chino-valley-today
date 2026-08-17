#!/usr/bin/env bash
# Nightly backup with 14-day rotation, plus offsite copy to Backblaze B2.
#
# Deliberately the SAME shape as foreshock/deploy/backup.sh and the Rush Call /
# SpotTheStar scripts: sqlite3 .backup + gzip, 14 local, rclone copy to a
# per-project B2 bucket, 14 remote, driven by a systemd timer. One backup
# mental model across every project matters more than per-project cleverness,
# because the person restoring is doing it under stress and should not have to
# remember which tool this one used.
#
# THE ONE DEPARTURE, and why: the other projects back up a single small
# database (SpotTheStar's whole snapshot is 64 KB). This project also has
# data/raw — ~104MB of content-addressed source documents, growing, and the
# thing PLAN.md calls the moat. Tarring that nightly would push the whole
# archive every run, because gzip output changes wholesale. Instead the archive
# is mirrored file-by-file with `rclone copy`: its filenames are content
# hashes, so files are immutable and each night uploads only what is new.
#
# `copy`, never `sync`. sync would propagate a local deletion to the offsite
# copy, which is precisely the failure the offsite copy exists to survive.
#
# NOT BACKED UP: .env. It holds the DO Inference key and the Gmail app
# password, and rclone copies to B2 unencrypted — the same reason the other
# three projects keep credentials on the box and out of the snapshot. Both keys
# are reissuable from their consoles; the archive is not.
#
# Configuration (in .env, or the unit's EnvironmentFile):
#   RCLONE_REMOTE        e.g. b2:chinovalley-backups
#   RCLONE_CONFIG        path to rclone.conf, mode 600
#   BACKUP_DIR           local snapshot dir, default ~/backups
#   BACKUP_KEEP_REMOTE   remote snapshots to keep, default 14
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env" ]; then
	set -a
	# shellcheck disable=SC1091  # path is runtime-dependent, not checkable here
	. "$ROOT/.env"
	set +a
fi

DB="${DB_PATH:-$ROOT/data/cvtoday.db}"
RAW="${RAW_PATH:-$ROOT/data/raw}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d)"
SNAP="$BACKUP_DIR/cvtoday-$STAMP.db"

# .backup is safe against a live WAL-mode database (unlike cp), which matters
# here because a scrape timer can fire mid-backup.
sqlite3 "$DB" ".backup '$SNAP'"

# Verify before shipping. A corrupt snapshot that uploads happily is worse than
# a failed run, because it looks like a backup for months.
result="$(sqlite3 "$SNAP" "PRAGMA integrity_check;")"
if [ "$result" != "ok" ]; then
	echo "backup: integrity check FAILED: $result" >&2
	rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm"
	exit 1
fi

# Opening the snapshot for that check creates sidecar -wal/-shm files. They
# carry nothing (the snapshot is already consistent) but the rotation below
# only matches *.db.gz, so left alone they would accumulate a pair per day
# forever.
rm -f "$SNAP-wal" "$SNAP-shm"

gzip -f "$SNAP"

# The content/ tree is small (markdown) and carries the human-reviewed queue,
# held drafts and published posts, so it rides along with the database.
tar -czf "$BACKUP_DIR/cvtoday-content-$STAMP.tar.gz" -C "$ROOT" content

# Rotate: keep 14 days locally.
find "$BACKUP_DIR" -name 'cvtoday-*.db.gz' -mtime +14 -delete
find "$BACKUP_DIR" -name 'cvtoday-content-*.tar.gz' -mtime +14 -delete

echo "backed up $DB -> $SNAP.gz"

if [ -n "${RCLONE_REMOTE:-}" ]; then
	RC=(rclone)
	[ -n "${RCLONE_CONFIG:-}" ] && RC+=(--config "$RCLONE_CONFIG")

	"${RC[@]}" copy "$SNAP.gz" "$RCLONE_REMOTE"
	"${RC[@]}" copy "$BACKUP_DIR/cvtoday-content-$STAMP.tar.gz" "$RCLONE_REMOTE"
	echo "offsite copy -> $RCLONE_REMOTE"

	# The raw archive, mirrored rather than snapshotted. Content-addressed
	# filenames mean rclone skips everything it already has.
	if [ -d "$RAW" ]; then
		"${RC[@]}" copy "$RAW" "$RCLONE_REMOTE/raw"
		echo "raw archive mirrored -> $RCLONE_REMOTE/raw"
	fi

	# Remote rotation: keep the newest BACKUP_KEEP_REMOTE of each snapshot
	# kind. The raw mirror is deliberately excluded — it is not a snapshot
	# series and must never be pruned.
	for pattern in 'cvtoday-[0-9].*\.db\.gz' 'cvtoday-content-.*\.tar\.gz'; do
		"${RC[@]}" lsf "$RCLONE_REMOTE" | grep -E "^$pattern$" | sort |
			head -n "-${BACKUP_KEEP_REMOTE:-14}" | while read -r f; do
			echo "  pruning remote $f"
			"${RC[@]}" delete "$RCLONE_REMOTE/$f"
		done
	done
else
	echo "backup: RCLONE_REMOTE not set — local snapshot only, no offsite copy" >&2
fi
