#!/usr/bin/env bash
# Nightly offsite backup to Backblaze B2 via restic.
#
# This is the real backup PLAN.md asks for ("the raw archive IS the moat; do
# not lose it"). scripts/interim-backup.sh stays as the local, run-it-by-hand
# snapshot; this one runs unattended on the droplet and pushes offsite.
#
# WHY RESTIC RATHER THAN A TARBALL PUSH
#
#   1. Dedup. data/raw is content-addressed and effectively append-only, so
#      chunk-level dedup makes each nightly snapshot cost roughly the new
#      bytes. Uploading `tar -czf` output instead would push the whole archive
#      every night, because gzip output changes wholesale.
#   2. Client-side encryption, which is not optional here: this backup set
#      includes .env, holding the DO Inference key and the Gmail app password
#      for the Nixle mailbox. Those must never sit in an object store in
#      cleartext.
#   3. Snapshot retention with a real forget/prune policy.
#
# CONFIGURATION (in .env on the droplet, or the unit's EnvironmentFile)
#
#   RESTIC_REPOSITORY      b2:<bucket>:chino-valley-today
#   RESTIC_PASSWORD_FILE   path to the repo password, chmod 600
#   B2_ACCOUNT_ID          B2 application key id
#   B2_ACCOUNT_KEY         B2 application key
#   CVT_BACKUP_PRUNE       set to 1 to also forget+prune (see below)
#
# THE REPO PASSWORD CANNOT LIVE ONLY IN THE BUCKET IT PROTECTS. Keep a copy in
# a password manager. Lose it and every snapshot is unrecoverable — restic has
# no recovery path, by design.
#
# PRUNING IS OPT-IN ON PURPOSE. The recommended B2 application key for this
# droplet can write but not delete, so a compromised droplet cannot destroy
# backup history — which is most of the value of having it offsite. Pruning
# needs delete capability, so run it deliberately from a trusted machine with
# a privileged key:  CVT_BACKUP_PRUNE=1 scripts/backup-b2.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# .env is the same file the pipeline reads; sourcing it keeps one place to
# configure the droplet. Not required — systemd can supply the environment.
if [ -f "$ROOT/.env" ]; then
	set -a
	# shellcheck disable=SC1091  # path is runtime-dependent, not checkable here
	. "$ROOT/.env"
	set +a
fi

for var in RESTIC_REPOSITORY RESTIC_PASSWORD_FILE B2_ACCOUNT_ID B2_ACCOUNT_KEY; do
	if [ -z "${!var:-}" ]; then
		echo "backup-b2: $var is not set — refusing to run" >&2
		exit 78
	fi
done
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE B2_ACCOUNT_ID B2_ACCOUNT_KEY

# Checked separately from the "is it set" loop above: a path that is set but
# missing is the likely first-run mistake, and restic's own error for it does
# not make clear which of several credentials is at fault.
if [ ! -r "$RESTIC_PASSWORD_FILE" ]; then
	echo "backup-b2: RESTIC_PASSWORD_FILE ($RESTIC_PASSWORD_FILE) is missing or unreadable" >&2
	echo "  create it with:  printf '%s' '<passphrase>' > $RESTIC_PASSWORD_FILE && chmod 600 $RESTIC_PASSWORD_FILE" >&2
	exit 78
fi

command -v restic >/dev/null || { echo "backup-b2: restic not installed" >&2; exit 127; }

DB="$ROOT/data/cvtoday.db"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/cvt-backup.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# A plain file copy of a live SQLite database is not a valid backup: with WAL
# journaling the committed data lives across .db/.db-wal and a copy can catch
# them mid-write. `.backup` takes a consistent snapshot through the SQLite API
# while readers and writers continue.
echo "backup-b2: snapshotting the database"
sqlite3 "$DB" ".backup '$STAGE/cvtoday.db'"

# Verify the copy before shipping it. A corrupt snapshot that uploads happily
# is worse than a failed run, because it looks like a backup for months.
echo "backup-b2: integrity check"
result="$(sqlite3 "$STAGE/cvtoday.db" "PRAGMA integrity_check;")"
if [ "$result" != "ok" ]; then
	echo "backup-b2: integrity check FAILED: $result" >&2
	exit 1
fi

# First run in a fresh bucket needs the repo created. Idempotent: an existing
# repo makes `init` fail, which is fine and not an error worth stopping for.
if ! restic cat config >/dev/null 2>&1; then
	echo "backup-b2: initialising repository"
	restic init
fi

# Backed up as directories, NOT tarballs — that is what lets dedup work.
targets=("$STAGE/cvtoday.db" "$ROOT/data/raw" "$ROOT/content")

# .env is included deliberately: restic encrypts client-side, and restoring
# data without the API keys would turn a restore into a re-provision. Set
# CVT_BACKUP_SKIP_ENV=1 to leave it out if the repo password is ever handled
# less carefully than the keys themselves.
if [ -f "$ROOT/.env" ] && [ "${CVT_BACKUP_SKIP_ENV:-0}" != "1" ]; then
	targets+=("$ROOT/.env")
fi

echo "backup-b2: uploading snapshot"
restic backup \
	--verbose \
	--tag cvtoday \
	--exclude-caches \
	"${targets[@]}"

if [ "${CVT_BACKUP_PRUNE:-0}" = "1" ]; then
	# Daily for a week, weekly for a month, monthly for a year. The archive is
	# small enough that this is cheap, and a corrupted-source bug found late
	# needs history to recover from.
	echo "backup-b2: forget + prune"
	restic forget --tag cvtoday \
		--keep-daily 7 --keep-weekly 4 --keep-monthly 12 \
		--prune
else
	echo "backup-b2: skipping prune (set CVT_BACKUP_PRUNE=1 with a delete-capable key)"
fi

echo "backup-b2: ok"
restic snapshots --tag cvtoday --latest 3 || true
