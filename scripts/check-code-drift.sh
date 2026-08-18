#!/usr/bin/env bash
# Is the droplet running the code that is on origin/main?
#
# WHY THIS EXISTS
#
# "Deploy on push to main" only ever rebuilt the SITE. Pipeline code reached
# the host solely when a human ran `scripts/deploy.sh code` from a developer
# machine, and nothing anywhere reported the gap. On 2026-08-17 the droplet ran
# two merges behind for a day: a merged scraper fix looked broken in production
# because it simply was not there, and the same drift recurred twice more that
# evening.
#
# Once CI ships code (deploy.sh host-update), that class of drift mostly goes
# away — which changes what this watches rather than removing the need for it.
# The remaining failure is a deploy that FAILS: the checkout guard refuses over
# divergent published content, npm ci dies, the runner is down. Those leave the
# host silently behind exactly as before, and a red Actions run is not a signal
# anyone reliably sees.
#
# Runs ON the host, read-only against git. Never resets, never deploys: it
# reports, so that fixing drift stays a deliberate act.
#
#   scripts/check-code-drift.sh
set -euo pipefail

# `git rev-parse`, not `[ -d .git ]`: in a git worktree .git is a FILE pointing
# at the real git dir, so the directory test rejects every worktree — including
# the ones this project's own tooling creates.
if ! git rev-parse --git-dir >/dev/null 2>&1 || [ ! -d scripts ]; then
	echo "check-code-drift: run this from the pipeline checkout root" >&2
	exit 66
fi

# ls-remote, NOT fetch. A fetch writes .git/FETCH_HEAD and any new objects, and
# this checkout's .git is root-owned because deploys run git as root — so a
# fetch as the service account dies with "cannot open '.git/FETCH_HEAD'". More
# to the point, a watchdog has no business mutating the thing it watches.
# ls-remote asks the remote for one ref and writes nothing.
main_sha="$(git ls-remote origin refs/heads/main | cut -f1)"
head_sha="$(git rev-parse HEAD)"

if [ -z "$main_sha" ]; then
	echo "check-code-drift: could not read origin/main (network? auth?)" >&2
	exit 69
fi

if [ "$head_sha" = "$main_sha" ]; then
	echo "ok: checkout matches origin/main ($(git log --oneline -1))"
	# Dead-man's-switch ping, on success only — the same inverted monitoring the
	# scrape groups use. The alarm is the ping NOT arriving.
	heartbeat="${CVT_HEARTBEAT_URL_DRIFT:-}"
	if [ -n "$heartbeat" ]; then
		curl -fsS --max-time 15 "$heartbeat" >/dev/null 2>&1 ||
			echo "note: heartbeat ping to CVT_HEARTBEAT_URL_DRIFT failed (check itself was fine)" >&2
	fi
	exit 0
fi

# No commit count: without a fetch we do not have origin's objects locally, and
# fetching to produce a nicer number would defeat the point above. The two shas
# say everything an operator needs.
echo "DRIFT: checkout does not match origin/main" >&2
echo "  HEAD:        $head_sha" >&2
echo "  origin/main: $main_sha" >&2
echo "  fix with: scripts/deploy.sh code   (from a developer machine)" >&2

# Flip the LIVE health file, the way brief-health.ts does for a missing brief.
#
# Reusing `pipeline=fresh` is a deliberate tradeoff, not an oversight. It does
# conflate two different faults under one keyword, and a reader seeing `stale`
# now has to check which. But the project has exactly one keyword monitor
# configured, watching for the ABSENCE of `pipeline=fresh` — so a distinct
# marker of our own would be a signal nobody receives, which is worth less than
# a slightly ambiguous one that actually pages. The `code=drifted` line below
# disambiguates on inspection, and if a second monitor is ever configured it
# should watch for `code=current` instead, at which point this flip can go.
web_root="${CVT_WEB_ROOT:-/var/www/chinovalley.today}"
health="$web_root/current/health"
if [ -w "$health" ]; then
	tmp="$(mktemp)"
	sed 's/^pipeline=fresh$/pipeline=stale/' "$health" >"$tmp"
	printf 'code=drifted head=%s main=%s\n' "${head_sha:0:7}" "${main_sha:0:7}" >>"$tmp"
	cat "$tmp" >"$health"
	rm -f "$tmp"
	echo "  marked $health pipeline=stale code=drifted" >&2
else
	echo "  could not write $health (not writable); systemd status is the only signal" >&2
fi

# Non-zero so `systemctl --failed` shows it too, and so the heartbeat above is
# never sent while the host is behind.
exit 1
