#!/usr/bin/env bash
# Commit newly published posts and push them to GitHub. Runs ON the droplet,
# as the service account, from a timer.
#
# WHY THIS EXISTS
#
# Posts are written here, not in git: Tier A publishes unattended at 05:50, and
# a human approving a post in the dashboard writes here too. Nothing sent them
# back, so git held an incomplete copy of what the site had published — 28
# posts adrift by 2026-09-09 — and every frontmatter migration had to be run
# twice, once in git and once here, because the two disagreed.
#
# A TIMER RATHER THAN A HOOK IN THE PUBLISH PATH
#
# Posts arrive by two routes (the Tier A runner, and dashboard approval) and
# would need the same call in both. A timer over the directory catches every
# route including ones added later, and a post reaching git minutes late costs
# nothing — this is a record, not a notification.
#
#   scripts/push-posts.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Same check as host-code-update.sh: `git rev-parse`, not `[ -d .git ]`, so a
# worktree is not rejected out of hand.
if ! git rev-parse --git-dir >/dev/null 2>&1 || [ ! -d content ]; then
	echo "push-posts: run this from the pipeline checkout root" >&2
	exit 66
fi

# The index must be clean before we touch it. `git commit` records the WHOLE
# index, not just the paths we staged, so anything an operator or an
# interrupted git left staged in this shared checkout would ride along into an
# unattended push to main. Refusing is right rather than filtering: on this
# host the index is always clean, so a dirty one means something is wrong and a
# person should look before posts continue to flow.
if ! git diff --cached --quiet; then
	echo "push-posts: the index already has staged changes; refusing" >&2
	git diff --cached --name-only | sed 's/^/    /' >&2
	echo "  Clear or commit them, then this will resume on the next run." >&2
	exit 70
fi

# --ignore-removal: stage additions and edits, never deletions.
#
# `git add <path>` has staged removals since git 2.0, so the plain form would
# turn a post disappearing from this directory into a commit deleting it from
# the record. Unpublishing something should be a deliberate act in the repo,
# not a side effect of a file going missing on a host — and a half-written
# directory during a restore would otherwise commit the gap.
#
# Gitignored daily briefs are skipped by `git add` for free.
git add --ignore-removal content/published

if git diff --cached --quiet; then
	echo "push-posts: no new posts staged"
else
	added="$(git diff --cached --diff-filter=A --name-only | wc -l | tr -d ' ')"
	edited="$(git diff --cached --diff-filter=M --name-only | wc -l | tr -d ' ')"
	echo "push-posts: $added new, $edited edited"
	git diff --cached --name-status | sed 's/^/  /'
	# --no-verify for the same reason the push below passes it: core.hooksPath
	# points at .githooks on this checkout too, and .githooks/pre-commit runs
	# Biome and tsc, which `npm ci --omit=dev` never installs here. Without it
	# the commit fails on the missing tools and leaves the index staged, and
	# the dirty-index guard above then refuses every later run.
	git commit --quiet --no-verify \
		-m "content: publish $added new, $edited edited from the host" \
		-m "Committed by scripts/push-posts.sh on the droplet."
fi

# Is there anything upstream does not have? This is asked AFTER the commit
# rather than instead of it, so it catches both cases: a commit just made, and
# one stranded here by an earlier run whose push failed.
#
# That second case is not hypothetical. A transient network or auth failure
# leaves a commit at HEAD with a clean index; without this test the next run
# would stage nothing, report "no new posts" and exit 0, and the posts would
# sit unpushed indefinitely — while host-code-update.sh refused every deploy
# because of the local commit upstream lacks.
git fetch --quiet origin main
if git merge-base --is-ancestor HEAD origin/main; then
	echo "push-posts: nothing to publish"
	exit 0
fi
# Every commit we are about to push must touch ONLY published content.
#
# The ancestry test above asks "is HEAD ahead of upstream?", which is what
# makes a stranded commit recoverable — but it cannot tell a stranded content
# commit from any other local commit. Someone debugging on this shared host,
# or a process committing in the checkout, would otherwise have their work
# pushed to main unattended by the next timer tick.
#
# This is the same failure as the dirty-index guard above, one stage later: a
# committed change walks straight past that check. Refused the same way, and
# for the same reason — on this host nothing but this script commits, so
# anything else means a person should look.
#
# Per commit, not the net diff of the range: someone debugging who edits a
# script, commits, then reverts it and commits again leaves a range whose net
# diff is empty, and their WIP would ride into main's history unremarked.
# --diff-merges=first-parent for the same reason one step up — a local merge
# lists no files at all by default, and a merge is exactly how a person drags
# unrelated work in here.
stray="$(git log --format= --name-only --diff-merges=first-parent \
	origin/main..HEAD -- ':!content/published' | sort -u)"
if [ -n "$stray" ]; then
	echo "push-posts: refusing to push commits that touch more than published content" >&2
	printf '%s\n' "$stray" | sed 's/^/    /' >&2
	echo "  This account publishes posts. Anything else goes through a PR." >&2
	exit 71
fi

echo "push-posts: $(git rev-list --count origin/main..HEAD) commit(s) to push"

# Rebase onto whatever upstream has before pushing, and retry: between the
# fetch and the push, CI or a person can land a commit, and the push is then
# rejected as non-fast-forward. Three attempts, because the window is seconds
# wide and a fourth would only be waiting for a human-scale problem.
#
# NOT `push --force` in any form. This account may add to the history and must
# never rewrite it.
attempt=1
while [ "$attempt" -le 3 ]; do
	git fetch --quiet origin main

	# A rebase conflict means git and this host both changed the same published
	# post. That is the one case a machine must not resolve: picking a side
	# silently is how a visible correction gets reverted. Abort, leave the
	# commit sitting here, and fail loudly — host-code-update.sh already
	# refuses to reset over a local commit upstream lacks, so nothing is lost
	# while someone looks at it.
	# --autostash because the worktree is not reliably clean. A published post
	# missing from this host is an unstaged deletion (we deliberately never
	# stage those, above), and plain `git rebase` refuses to start with any
	# unstaged change — so a single missing file would wedge every future run
	# and report it as a conflict it is not. Autostash sets that state aside,
	# rebases, and puts it back exactly as it was.
	if ! git rebase --quiet --autostash origin/main; then
		git rebase --abort || true
		echo "push-posts: rebase onto origin/main conflicted." >&2
		echo "  Both this host and the repo changed the same published post." >&2
		echo "  The commit is still here; resolve it by hand." >&2
		exit 75
	fi

	# --no-verify because this checkout has core.hooksPath=.githooks, and
	# .githooks/pre-push runs the full test suite plus fallow. That gate exists
	# to stop bad CODE leaving a developer machine; this pushes only published
	# content, on a shared production droplet, where a multi-minute npm test on
	# every content push is both useless and antisocial.
	#
	# Unsetting core.hooksPath on the host instead would not hold: package.json's
	# `prepare` script sets it, and host-code-update.sh runs `npm ci` on every
	# deploy, so it comes straight back.
	if git push --quiet --no-verify origin HEAD:main; then
		echo "push-posts: pushed $(git rev-parse --short HEAD)"
		exit 0
	fi

	echo "push-posts: push rejected, retrying ($attempt/3)" >&2
	attempt=$((attempt + 1))
done

echo "push-posts: could not push after 3 attempts" >&2
exit 1
