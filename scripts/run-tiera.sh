#!/usr/bin/env bash
# Generate and publish the Tier A posts, then rebuild the site so they are
# actually served.
#
# Why this exists: src/tiera/run.ts had no caller anywhere in deploy/, scripts/
# or .github/. The generators were written, tested and merged, and then only
# ever ran when someone invoked `npm run tiera` by hand — so on the droplet the
# meeting previews, weather alerts, business tracker, news digest and Nixle
# releases were never published at all. Ingest ran on a timer; publication did
# not.
#
# Used by cvt-tiera.timer (deploy/systemd/) at 05:50 Pacific: after the 05:40
# daily scrape has refreshed the database, and before the 06:00 brief, so a
# morning brief assembles against posts that already exist.
#
# The rebuild is part of this script for the same reason it is part of
# run-brief.sh: the site is static, so creating a post without rebuilding
# leaves readers looking at yesterday's front page. Each unit is self-contained
# rather than depending on a later one to publish its work.
#
#   scripts/run-tiera.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Tier A generation is idempotent by design (createPost updates a still-queued
# post in place and refuses to touch one already published or rejected, and
# slugs are stable across runs), so a re-run after a failure is safe and never
# duplicates a post for the same meeting, alert or week.
node src/tiera/run.ts

scripts/deploy.sh local

# Dead-man's-switch ping, on success only — same inverted monitoring as
# scripts/run-group.sh: the alarm is the ping NOT arriving. A pipeline that
# silently stops publishing looks perfectly healthy to any uptime check
# pointed at the site, which is exactly how the missing caller went unnoticed.
heartbeat="${CVT_HEARTBEAT_URL_TIERA:-}"
if [ -n "$heartbeat" ]; then
	# Never let a monitoring outage fail the run itself.
	curl -fsS --max-time 15 "$heartbeat" >/dev/null 2>&1 ||
		echo "note: heartbeat ping to CVT_HEARTBEAT_URL_TIERA failed (run itself was fine)" >&2
fi
