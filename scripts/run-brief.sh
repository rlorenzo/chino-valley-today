#!/usr/bin/env bash
# Assemble the morning daily brief, then rebuild and publish the site so the
# brief is actually served — the site is static, so publishing a post without
# rebuilding would leave readers on yesterday's front page.
#
# Used by cvt-brief.timer (deploy/systemd/) at 06:00 Pacific. The assembler
# reads only the local database (no network fetches); the 05:17 frequent
# scrape and the 05:40 daily scrape have already refreshed it by then.
#
#   scripts/run-brief.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Bounded retry loop for prerequisite freshness: up to 3 minutes (6 attempts x 30s)
# Allows in-flight or slightly delayed scrapers from the 05:40 group to finish cleanly.
ATTEMPTS="${CVT_PREREQ_MAX_ATTEMPTS:-6}"
DELAY="${CVT_PREREQ_RETRY_DELAY_SEC:-30}"
success=0

for ((i=1; i<=ATTEMPTS; i++)); do
	if node src/pipeline/daily-brief.ts --check-prereqs; then
		success=1
		break
	fi
	if [ "$i" -lt "$ATTEMPTS" ]; then
		echo "Prerequisites not ready (attempt $i/$ATTEMPTS). Retrying in ${DELAY}s..." >&2
		sleep "$DELAY"
	fi
done

if [ "$success" -ne 1 ]; then
	echo "ERROR: Prerequisite scrape sources failed freshness gate after $ATTEMPTS attempts." >&2
	exit 1
fi

node src/pipeline/daily-brief.ts
scripts/deploy.sh local

# Dead-man's-switch ping, on success only — same inverted monitoring as
# scripts/run-group.sh: the alarm is the ping NOT arriving, because a static
# site that silently stops getting a morning brief looks healthy to every
# normal uptime check.
heartbeat="${CVT_HEARTBEAT_URL_BRIEF:-}"
if [ -n "$heartbeat" ]; then
	# Never let a monitoring outage fail the brief run itself.
	curl -fsS --max-time 15 "$heartbeat" >/dev/null 2>&1 ||
		echo "note: heartbeat ping to CVT_HEARTBEAT_URL_BRIEF failed (brief itself was fine)" >&2
fi
