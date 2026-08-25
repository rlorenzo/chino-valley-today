#!/usr/bin/env bash
# Is the droplet running the code that is on origin/main — and are the systemd
# units that code ships actually installed and running?
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
# UNITS, TOO — the code being current is not the same as the code RUNNING.
#
# host-update deliberately never writes /etc/systemd/system or runs
# daemon-reload: the CI key belongs to an unprivileged account on a shared
# host, and installing units is root. So a merge that ships a new timer ships
# it inert. On 2026-08-19 that put cvt-scrape-press.timer and
# cvt-check-tos.timer on disk with nothing scheduling them — the press
# scrapers existed and never ran, and the ToS drift watchdog (the mechanism
# that halts scraping when a publisher changes terms) did not run at all. It
# was caught by reading the droplet, not by any alarm; this check compared
# HEAD to origin/main, saw a healthy checkout, and had no idea. Same shape as
# the cvt-tiera incident: shipped, disabled, silent.
#
# So this also diffs deploy/systemd/ against the installed copies, and checks
# that every repo-shipped timer is actually active — `deploy.sh code` enforces
# active-at-deploy for exactly the cvt-tiera reason, and this is the between-
# deploys half of that guarantee. Read-only throughout: installing units is
# deliberately a privileged manual step (see the shared-host note in
# deploy.sh), and an hourly alarm is the right cost for something that changes
# far less often than code. This unit runs as the service account; unit files
# under /etc/systemd/system are world-readable and `systemctl is-active` is an
# unprivileged query, so no elevation is needed to watch either.
#
# Runs ON the host, read-only against git and systemd. Never resets, never
# deploys, never installs: it reports, so that fixing drift stays a deliberate
# act.
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

# ── Check 1: is the checkout on origin/main? ────────────────────────────────
#
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

code_drifted=0
if [ "$head_sha" != "$main_sha" ]; then
	code_drifted=1
fi

# ── Check 2: are the repo's systemd units installed, current, and running? ──
#
# The comparison baseline is the CHECKOUT's deploy/systemd/, not origin's.
# That is deliberate: when the checkout itself is behind, check 1 already
# fires, and comparing installed units against files we do not have locally
# would need a fetch (see above). Both checks report independently, so a
# behind checkout with stale units raises both alarms, each naming its own
# remediation target.
#
# The override variables exist for the integration test
# (tests/integration/check-unit-drift.test.sh), which exercises this logic
# against fixture directories; production sets neither.
units_dir="${CVT_UNITS_DIR:-deploy/systemd}"
installed_dir="${CVT_SYSTEMD_DIR:-/etc/systemd/system}"

# On a machine with no installed-units directory at all — a developer laptop,
# macOS — every unit would read as "missing", which is a statement about the
# machine, not the deploy. The droplet always has the directory, so skipping
# here can never hide a real fault there.
if [ ! -d "$installed_dir" ]; then
	echo "note: $installed_dir does not exist; skipping the unit-install check (not a systemd host?)"
	installed_dir=""
fi

missing=""
differ=""
inactive=""
if [ -n "$installed_dir" ]; then
	for repo_unit in "$units_dir"/*; do
		[ -f "$repo_unit" ] || continue
		name="$(basename "$repo_unit")"
		if [ ! -f "$installed_dir/$name" ]; then
			missing="$missing $name"
		elif ! cmp -s "$repo_unit" "$installed_dir/$name"; then
			differ="$differ $name"
		fi
	done
fi

# Installed and byte-identical is still not RUNNING — cvt-tiera sat installed
# and disabled for weeks. Only timers: services here are either timer-started
# oneshots (active for seconds, so is-active would false-alarm hourly) or
# cvt-admin, which is enabled by hand on purpose. And only timers present in
# the installed dir: a missing timer is already reported above, and piling an
# "inactive" line on top of a "missing" line for the same unit is noise.
#
# Skipped without systemd (developer machines, the integration test's happy
# path stubs it instead) — the file comparison above still runs everywhere.
if [ -n "$installed_dir" ] && command -v systemctl >/dev/null 2>&1; then
	for repo_unit in "$units_dir"/*.timer; do
		[ -f "$repo_unit" ] || continue
		name="$(basename "$repo_unit")"
		[ -f "$installed_dir/$name" ] || continue
		systemctl is-active --quiet "$name" 2>/dev/null ||
			inactive="$inactive $name"
	done
fi

units_drifted=0
if [ -n "$missing$differ$inactive" ]; then
	units_drifted=1
fi

# Installed cvt-* units the repo no longer ships are only a note, not an
# alarm: `deploy.sh code` rsyncs without --delete, so a renamed unit leaves
# its old name behind, and whether the leftover should be stopped and removed
# is a judgment call for the operator, not a fault state. But a leftover TIMER
# keeps firing old code forever, so it deserves the mention.
# Guarded like the two loops above: with the unit-install check skipped,
# installed_dir is empty and "$installed_dir"/cvt-* expands to /cvt-* — a scan
# of the filesystem root, which would contradict the "skipped" note the report
# prints and could name a stray /cvt-* file as a leftover unit.
orphans=""
if [ -n "$installed_dir" ]; then
	for inst_unit in "$installed_dir"/cvt-*; do
		[ -f "$inst_unit" ] || continue
		name="$(basename "$inst_unit")"
		[ -f "$units_dir/$name" ] || orphans="$orphans $name"
	done
fi

# ── Report ──────────────────────────────────────────────────────────────────
if [ "$code_drifted" = 0 ] && [ "$units_drifted" = 0 ]; then
	units_note="units installed, current and running"
	[ -z "$installed_dir" ] && units_note="unit-install check skipped"
	echo "ok: checkout matches origin/main ($(git log --oneline -1)); $units_note"
	if [ -n "$orphans" ]; then
		echo "note: installed but not in repo (leftover from a rename? consider disabling):$orphans"
	fi
	# Dead-man's-switch ping, on success only — the same inverted monitoring the
	# scrape groups use. The alarm is the ping NOT arriving.
	heartbeat="${CVT_HEARTBEAT_URL_DRIFT:-}"
	if [ -n "$heartbeat" ]; then
		curl -fsS --max-time 15 "$heartbeat" >/dev/null 2>&1 ||
			echo "note: heartbeat ping to CVT_HEARTBEAT_URL_DRIFT failed (check itself was fine)" >&2
	fi
	exit 0
fi

if [ "$code_drifted" = 1 ]; then
	# No commit count: without a fetch we do not have origin's objects locally,
	# and fetching to produce a nicer number would defeat the point above. The
	# two shas say everything an operator needs.
	echo "DRIFT: checkout does not match origin/main" >&2
	echo "  HEAD:        $head_sha" >&2
	echo "  origin/main: $main_sha" >&2
fi
if [ "$units_drifted" = 1 ]; then
	echo "DRIFT: systemd units do not match $units_dir" >&2
	[ -n "$missing" ] && echo "  not installed:$missing" >&2
	[ -n "$differ" ] && echo "  installed but differ from repo:$differ" >&2
	[ -n "$inactive" ] && echo "  installed but not running:$inactive" >&2
fi
if [ -n "$orphans" ]; then
	echo "  note: installed but not in repo (leftover from a rename? consider disabling):$orphans" >&2
fi
# `all`, not `code`. Two reasons, and the second is what makes the markers
# below safe: new pipeline code can change how posts render, so the site should
# be rebuilt from it anyway; and a rebuild regenerates the health file from
# scratch, which is what clears the markers written below. `code` alone updates
# the checkout and units but leaves the alarm firing after the cause is gone —
# an alert that outlives its fault is worse than none, because it teaches you
# to ignore it. (CI's host-update path rebuilds too, so pure code drift
# self-clears; unit drift cannot, because installing units is root — see top.)
#
# This advice was itself half the trap on 2026-08-24. It was correct about the
# markers and dangerous about the content: `all` then meant `deploy_code;
# deploy_site`, and deploy_site built the site on the developer machine running
# it and published that over 43 pages of host-only content. `all` now rebuilds
# on the host, so the remediation and the safe path are finally the same
# command.
echo "  fix with: scripts/deploy.sh all   (from a developer machine)" >&2

# Flip the LIVE health file, the way brief-health.ts does for a missing brief.
#
# Reusing `pipeline=fresh` is a deliberate tradeoff, not an oversight. It does
# conflate different faults under one keyword, and a reader seeing `stale`
# now has to check which. But the project has exactly one keyword monitor
# configured, watching for the ABSENCE of `pipeline=fresh` — so a distinct
# marker of our own would be a signal nobody receives, which is worth less than
# a slightly ambiguous one that actually pages. The `code=drifted` /
# `units=drifted` lines below disambiguate on inspection, and if a second
# monitor is ever configured it should watch for `code=current` instead, at
# which point this flip can go.
#
# Nothing here ever un-flips, which is the same contract brief-health.ts works
# under: the markers live in the BUILT health file, so the next site rebuild
# regenerates the page and clears them. That is why the remediation printed
# above is `deploy.sh all` rather than `code` — the rebuild is what closes the
# alarm. Un-flipping from here would be worse than useless, since this script
# cannot tell whether `pipeline=stale` was set by itself or by the brief
# watchdog, and restoring it could silence a real missing-brief alert. For the
# same reason each marker line is stripped only when ITS check fired and is
# being rewritten: a stale marker from the other check is cleared by the next
# rebuild, not by us guessing.
web_root="${CVT_WEB_ROOT:-/var/www/chinovalley.today}"
health="$web_root/current/health"
if [ -w "$health" ]; then
	# Idempotent: strip any previous marker before writing this one. Drift
	# persists until someone deploys, and nothing here un-flips, so an hourly
	# timer would otherwise append a line every hour — an unbounded, live
	# /health page carrying a stack of contradictory lines, each naming a
	# different sha or unit set as things move on. One marker per check,
	# always current.
	sed_args=(-e 's/^pipeline=fresh$/pipeline=stale/')
	[ "$code_drifted" = 1 ] && sed_args+=(-e '/^code=drifted /d')
	[ "$units_drifted" = 1 ] && sed_args+=(-e '/^units=drifted /d')
	tmp="$(mktemp)"
	sed "${sed_args[@]}" "$health" >"$tmp"
	if [ "$code_drifted" = 1 ]; then
		printf 'code=drifted head=%s main=%s\n' "${head_sha:0:7}" "${main_sha:0:7}" >>"$tmp"
	fi
	if [ "$units_drifted" = 1 ]; then
		units_marker="units=drifted"
		# The lists carry a leading space, so `echo $list | tr` (unquoted, word-
		# split on purpose) yields a clean comma-joined value.
		# shellcheck disable=SC2086
		[ -n "$missing" ] && units_marker="$units_marker missing=$(echo $missing | tr ' ' ',')"
		# shellcheck disable=SC2086
		[ -n "$differ" ] && units_marker="$units_marker differ=$(echo $differ | tr ' ' ',')"
		# shellcheck disable=SC2086
		[ -n "$inactive" ] && units_marker="$units_marker inactive=$(echo $inactive | tr ' ' ',')"
		printf '%s\n' "$units_marker" >>"$tmp"
	fi
	cat "$tmp" >"$health"
	rm -f "$tmp"
	echo "  marked $health pipeline=stale" >&2
else
	echo "  could not write $health (not writable); systemd status is the only signal" >&2
fi

# Non-zero so `systemctl --failed` shows it too, and so the heartbeat above is
# never sent while the host is behind.
exit 1
