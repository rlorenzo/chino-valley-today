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

# ls-remote, NOT fetch.
#
# A fetch writes .git/FETCH_HEAD. The checkout directory and .git itself are
# owned by the service account, but individual files inside .git — FETCH_HEAD,
# index, ORIG_HEAD, config — are root-owned, because `deploy.sh code` runs git
# as root. So a fetch as the service account dies with
# "cannot open '.git/FETCH_HEAD': Permission denied", which is how this was
# found.
#
# Read-only plumbing is unaffected: rev-parse and ls-remote work fine as the
# service account (verified on the droplet), and git's dubious-ownership check
# keys off the repository directory's owner, which is cvtoday — not off the
# root-owned files within it.
#
# More to the point than either: a watchdog has no business mutating the thing
# it watches. ls-remote asks the remote for one ref and writes nothing.
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
# `all`, not `code`. Two reasons, and the second is what makes the marker below
# safe: new pipeline code can change how posts render, so the site should be
# rebuilt from it anyway; and a rebuild regenerates the health file from
# scratch, which is what clears the markers written below. `code` alone updates
# the checkout and leaves the alarm firing after the cause is gone — an alert
# that outlives its fault is worse than none, because it teaches you to ignore
# it. (CI's host-update path rebuilds too, so it self-clears.)
echo "  fix with: scripts/deploy.sh all   (from a developer machine)" >&2

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
#
# Nothing here ever un-flips, which is the same contract brief-health.ts works
# under: the markers live in the BUILT health file, so the next site rebuild
# regenerates the page and clears them. That is why the remediation printed
# above is `deploy.sh all` rather than `code` — the rebuild is what closes the
# alarm. Un-flipping from here would be worse than useless, since this script
# cannot tell whether `pipeline=stale` was set by itself or by the brief
# watchdog, and restoring it could silence a real missing-brief alert.
web_root="${CVT_WEB_ROOT:-/var/www/chinovalley.today}"
health="$web_root/current/health"
if [ -w "$health" ]; then
	# Idempotent: strip any previous marker before writing this one. Drift
	# persists until someone deploys, and nothing here un-flips, so an hourly
	# timer would otherwise append a line every hour — an unbounded, live
	# /health page carrying a stack of contradictory code= lines, each naming a
	# different main sha as origin moves on. One marker, always current.
	tmp="$(mktemp)"
	sed -e 's/^pipeline=fresh$/pipeline=stale/' -e '/^code=drifted /d' "$health" >"$tmp"
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
