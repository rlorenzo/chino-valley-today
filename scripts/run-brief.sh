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

# Bounded retry loop for prerequisite freshness.
#
# WHY THIS RE-SCRAPES
#
# This loop used to re-run the same read-only check against the same database
# and do nothing else. Nothing re-fetched between attempts, so against a hard
# source failure all six attempts were guaranteed to return an identical
# answer: three minutes spent re-asking a question whose answer could not have
# changed. On 2026-08-20 the journal recorded exactly that — six identical
# failures thirty seconds apart, then exit 1 and no brief.
#
# Retrying only means something if something is retried. Each attempt now
# re-scrapes the BLOCKING sources that are stale (--list-blocking-stale names
# them) before asking again, which is what lets the loop ride out the
# transient upstream blip it always claimed to cover.
#
# Only blocking sources are re-scraped. An optional source being down no
# longer holds the brief, so re-fetching it here would spend the retry budget
# on something that publishes either way.
#
# Worst case, measured against the unit's TimeoutStartSec=20min: both blocking
# sources are NWS feeds making two document fetches each, and src/fetch.ts
# bounds one fetch at 60s (line 187) with a 2s per-host delay (line 9) plus a
# 15s robots fetch per process (line 141). A fully pathological round, every
# request hanging to its ceiling, is therefore about 2 x (15 + 2x62) = 278s;
# three rounds ~14min, plus 3x30s of sleep, is ~15.5min before the assemble
# and site rebuild even start. That fits, with roughly four minutes to spare.
# Typical is a few seconds. Raising ATTEMPTS without also raising
# TimeoutStartSec would eat that margin.
ATTEMPTS="${CVT_PREREQ_MAX_ATTEMPTS:-4}"
DELAY="${CVT_PREREQ_RETRY_DELAY_SEC:-30}"
success=0

for ((i = 1; i <= ATTEMPTS; i++)); do
	if node src/pipeline/daily-brief.ts --check-prereqs; then
		success=1
		break
	fi
	if [ "$i" -lt "$ATTEMPTS" ]; then
		echo "Prerequisites not ready (attempt $i/$ATTEMPTS)." >&2
		# Collected into an array rather than piped into a loop: a pipeline runs
		# its body in a subshell, so a scraper failure there could not be seen.
		stale=()
		while IFS= read -r key; do
			[ -n "$key" ] && stale+=("$key")
		done < <(node src/pipeline/daily-brief.ts --list-blocking-stale || true)
		if [ "${#stale[@]}" -gt 0 ]; then
			for key in "${stale[@]}"; do
				echo "  re-scraping blocking source '$key'..." >&2
				# A failed re-scrape is not fatal here: the next --check-prereqs is
				# the arbiter, and the source may still recover on a later attempt.
				node src/run-one.ts "$key" || echo "  re-scrape of '$key' failed" >&2
			done
		fi
		sleep "$DELAY"
	fi
done

if [ "$success" -ne 1 ]; then
	echo "ERROR: Blocking prerequisite sources failed the freshness gate after $ATTEMPTS attempts." >&2
	exit 1
fi

node src/pipeline/daily-brief.ts
scripts/deploy.sh local

# NO dead-man's-switch ping here, deliberately.
#
# The inverted-monitoring reasoning was right — a static site that quietly
# stops receiving a brief looks healthy to any ordinary uptime check — but
# this project's monitor cannot receive a heartbeat: the UptimeRobot plan in
# use has no cron/heartbeat monitor type. What it does have is keyword
# detection, so the signal lives in the built health file instead. /health
# carries `pipeline=fresh`; brief-health.ts flips it to `pipeline=stale` when
# today's brief is missing, and the monitor alerts on the ABSENCE of
# `pipeline=fresh`. An unset CVT_HEARTBEAT_URL_BRIEF was dead code wearing the
# costume of a safety net, which is worse than an absent one: it reads as
# covered to anyone auditing this file.
