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

# `git rev-parse`, not `[ -d .git ]`: in a git worktree .git is a FILE pointing
# at the real git dir, so the directory test rejects every worktree.
if ! git rev-parse --git-dir >/dev/null 2>&1 || [ ! -d content ]; then
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
# The question is "would the reset LOSE it?", and exactly two things answer yes:
#
# 1. Uncommitted edits to tracked posts — a correction typed onto a published
#    post, or a generator rewriting one. `git diff HEAD` catches these whether
#    staged or not. This is the case the guard exists for.
#
# 2. Commits made HERE that upstream does not have. Normally none: the host
#    never commits. But `reset --hard` discards them, and unlike case 1 there
#    is no working-tree edit left behind to notice afterwards.
#
# What does NOT answer yes, and cost a manual intervention on 2026-08-23 by
# being treated as though it did:
#
# - Upstream having moved. Comparing the working tree to origin/main reports a
#   difference when GIT changes too, not just when the host does — and
#   `git diff` cannot say which side moved. Task 4.5 committed a `topics:`
#   block onto seven published posts; the host had no edits of its own, the
#   reset would have lost nothing, and every deploy failed until someone
#   fast-forwarded the checkout by hand. Any commit touching a published post
#   would have done the same. Compare against HEAD, not origin/main.
#
# - Untracked and ignored files. `git reset --hard` leaves them alone. Daily
#   briefs are gitignored on purpose (regenerated here every morning), and
#   flagging them would block every deploy, permanently.
divergent=()

# Appends the published paths `git diff <revs>` reports. A read loop rather
# than `mapfile`, which bash 3.2 does not have — that is what macOS ships, and
# what runs tests/integration/host-code-update.test.sh.
collect_divergent() {
	while IFS= read -r path; do
		divergent+=("$path")
	done < <(git diff --name-only "$@" -- content/published)
}

# Case 1.
collect_divergent HEAD

# Case 2. `origin/main...HEAD` is the HEAD side of the fork point: content this
# checkout committed and upstream never saw. Skipped entirely when HEAD is an
# ancestor of origin/main, which is the normal "host is simply behind" state.
if ! git merge-base --is-ancestor HEAD origin/main; then
	collect_divergent origin/main...HEAD
fi

if [ ${#divergent[@]} -gt 0 ]; then
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	safe="$HOME/diverged-content/$stamp"
	mkdir -p "$safe"
	cp -a content/published/. "$safe/"
	echo 'host-code-update: content/published here has changes origin/main does not.' >&2
	echo "  A copy is safe at $safe" >&2
	echo '  These would be LOST by the reset:' >&2
	printf '    %s\n' "${divergent[@]}" | sort -u >&2
	echo '  Commit them to the repo (or discard them), then deploy again.' >&2
	exit 75
fi

git reset --hard --quiet origin/main
npm ci --omit=dev --silent
git log --oneline -1
