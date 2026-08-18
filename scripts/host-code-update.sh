#!/usr/bin/env bash
# Update the pipeline checkout on the droplet: fetch, refuse to destroy
# anything published only here, hard reset to origin/main, reinstall
# production dependencies.
#
# Runs ON the host, from the checkout root — either over SSH from
# `scripts/deploy.sh code`, or as the unprivileged service account from
# `scripts/deploy.sh host-update`.
#
# Deliberately does NOT touch /etc/systemd/system. Installing units needs root,
# and the CI deploy key is scoped to an unprivileged account on purpose; unit
# installation stays a root step in `scripts/deploy.sh code`. Units change far
# less often than pipeline code, which is what makes that split affordable.
#
#   scripts/host-code-update.sh
set -euo pipefail

if [ ! -d .git ] || [ ! -d content ]; then
	echo "host-code-update: run this from the pipeline checkout root" >&2
	exit 66
fi

git fetch --quiet origin main

# Refuse to reset over published content that exists ONLY here.
#
# content/published is tracked AND the pipeline writes to it when a human
# approves a post in the dashboard, so a bare `git reset --hard` can destroy a
# human-approved post — or a visible correction edited onto an existing one,
# which is the silent edit EDITORIAL.md forbids. That is not hypothetical: a
# Tier A run overwrote three dated correction notes on 2026-08-18.
#
# Two things this must get right, both learned the hard way:
#
# 1. Compare against origin/main, NOT against HEAD. `git status --porcelain`
#    reported every post already committed upstream as divergent, purely
#    because this checkout had not caught up — so the guard blocked the very
#    reset that would have tracked it, and refused every deploy until someone
#    deleted files by hand. The question is not "does this differ from what we
#    have?" but "would the reset LOSE it?"
#
# 2. Only TRACKED paths are at risk. `git reset --hard` leaves untracked and
#    ignored files alone, so a scan of the directory itself over-reports —
#    daily briefs are gitignored on purpose (they are regenerated here every
#    morning) and flagging them would block every deploy, permanently.
#
# `git diff --name-only origin/main -- content/published` is exactly the set of
# tracked paths where the working tree differs from origin/main: posts modified
# here, and posts committed here that upstream would delete. Nothing else.
mapfile -t divergent < <(git diff --name-only origin/main -- content/published)

if [ ${#divergent[@]} -gt 0 ]; then
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	safe="$HOME/diverged-content/$stamp"
	mkdir -p "$safe"
	cp -a content/published/. "$safe/"
	echo 'host-code-update: content/published here differs from origin/main.' >&2
	echo "  A copy is safe at $safe" >&2
	echo '  These would be LOST by the reset:' >&2
	printf '    %s\n' "${divergent[@]}" >&2
	echo '  Commit them to the repo (or discard them), then deploy again.' >&2
	exit 75
fi

git reset --hard --quiet origin/main
npm ci --omit=dev --silent
git log --oneline -1
