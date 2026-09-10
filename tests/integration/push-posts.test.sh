#!/usr/bin/env bash
# Integration test for scripts/push-posts.sh: the droplet's write-back path.
#
# Everything runs against fixtures — a local bare repo stands in for GitHub, so
# nothing here needs network or a deploy key. The script is copied into the
# fixture checkout because it locates the repo root from its own path.
#
# Each case is a way the record could be corrupted rather than merely a way the
# script could fail:
#   - a new post reaches upstream
#   - a post disappearing from the host does NOT commit a deletion
#   - gitignored daily briefs never reach the repo
#   - a genuine conflict stops, keeping the commit, rather than picking a side
#   - a commit stranded by a failed push is retried, not forgotten
#   - a dirty index is refused rather than swept into the commit
#   - a commit touching anything but published content is never pushed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Keep the operator's real git config (signing, hooks, templates) out of this.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
git_c() { git -c user.name=test -c user.email=test@test -c commit.gpgsign=false "$@"; }

UPSTREAM="$TMP_DIR/upstream.git"
HOST="$TMP_DIR/host"

echo "0. Building fixtures..."
git_c init --quiet --bare -b main "$UPSTREAM"
git_c init --quiet -b main "$HOST"
mkdir -p "$HOST/scripts" "$HOST/content/published"
printf 'content/published/*-daily-brief.md\n' >"$HOST/.gitignore"
printf -- '---\ntitle: first\n---\n' >"$HOST/content/published/2026-01-01-first.md"
(cd "$HOST"
	git_c add -A
	git_c commit --quiet -m "seed"
	git_c remote add origin "$UPSTREAM"
	git_c push --quiet -u origin main
	git_c config user.name test
	git_c config user.email test@test
	git_c config commit.gpgsign false)
cp "$ROOT/scripts/push-posts.sh" "$HOST/scripts/"

run_push() {
	set +e
	OUT="$(cd "$HOST" && bash scripts/push-posts.sh 2>&1)"
	CODE=$?
	set -e
}

upstream_has() {
	git_c -C "$UPSTREAM" ls-tree -r --name-only main | grep -qx "$1"
}

echo "1. A quiet run commits nothing and succeeds..."
before="$(git_c -C "$HOST" rev-parse HEAD)"
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0, got $CODE"; echo "$OUT"; exit 1; }
[ "$(git_c -C "$HOST" rev-parse HEAD)" = "$before" ] || {
	echo "FAIL: a quiet run created a commit"; exit 1; }
echo "OK: nothing to publish is not an error."

echo "2. A new post is committed and reaches upstream..."
printf -- '---\ntitle: second\n---\n' >"$HOST/content/published/2026-01-02-second.md"
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0, got $CODE"; echo "$OUT"; exit 1; }
upstream_has content/published/2026-01-02-second.md || {
	echo "FAIL: the new post never reached upstream"; echo "$OUT"; exit 1; }
echo "OK: new post pushed."

echo "3. A gitignored daily brief is never committed..."
printf -- '---\ntitle: brief\n---\n' >"$HOST/content/published/2026-01-03-daily-brief.md"
printf -- '---\ntitle: third\n---\n' >"$HOST/content/published/2026-01-03-third.md"
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0, got $CODE"; echo "$OUT"; exit 1; }
upstream_has content/published/2026-01-03-third.md || {
	echo "FAIL: the ordinary post did not reach upstream"; exit 1; }
if upstream_has content/published/2026-01-03-daily-brief.md; then
	echo "FAIL: a daily brief was committed"; exit 1
fi
echo "OK: briefs stay on the host."

echo "4. A post removed from the host does NOT commit a deletion..."
# `git add <path>` has staged removals since git 2.0. Without --ignore-removal
# a file vanishing here — a bad restore, a half-finished move — would quietly
# delete it from the published record.
rm "$HOST/content/published/2026-01-01-first.md"
printf -- '---\ntitle: fourth\n---\n' >"$HOST/content/published/2026-01-04-fourth.md"
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0, got $CODE"; echo "$OUT"; exit 1; }
upstream_has content/published/2026-01-01-first.md || {
	echo "FAIL: a removed post was deleted from the repo"; echo "$OUT"; exit 1; }
echo "OK: removals are never pushed."
# Restore it so the tracked tree matches the host again.
git_c -C "$HOST" checkout -- content/published/2026-01-01-first.md

echo "5. A conflicting edit stops, and keeps the commit..."
# Upstream edits a published post; the host edits the same one differently.
# That is the visible-correction case, and picking a side silently is exactly
# what must not happen.
OTHER="$TMP_DIR/other"
git_c clone --quiet "$UPSTREAM" "$OTHER"
printf -- '---\ntitle: from-the-repo\n---\n' >"$OTHER/content/published/2026-01-02-second.md"
(cd "$OTHER"
	git_c add -A
	git_c commit --quiet -m "repo-side edit"
	git_c push --quiet origin main)
printf -- '---\ntitle: from-the-host\n---\n' >"$HOST/content/published/2026-01-02-second.md"
run_push
[ "$CODE" -eq 75 ] || { echo "FAIL: expected exit 75, got $CODE"; echo "$OUT"; exit 1; }
case "$OUT" in
	*conflict*) ;;
	*) echo "FAIL: the refusal does not name the conflict: $OUT"; exit 1 ;;
esac
# The commit must survive: host-code-update.sh refuses to reset over a local
# commit upstream lacks, so nothing is lost while a human looks at it. If the
# script had left the tree mid-rebase, that guard would not apply.
git_c -C "$HOST" rev-parse --verify HEAD >/dev/null || {
	echo "FAIL: HEAD is unusable after the aborted rebase"; exit 1; }
if [ -d "$HOST/.git/rebase-merge" ] || [ -d "$HOST/.git/rebase-apply" ]; then
	echo "FAIL: the checkout was left mid-rebase"; exit 1
fi
git_c -C "$HOST" log --oneline -1 | grep -q "content: publish" || {
	echo "FAIL: the commit was lost by the abort"; exit 1; }
echo "OK: conflict refused, commit retained, tree clean."

# Resolve it the way an operator would, so the cases below start clean. Note
# what this proves in passing: until someone does this, EVERY later run fails
# the same way. That is the intended behaviour — a conflict over a published
# post stops the line rather than guessing — but it means a conflict is a page,
# not a warning.
(cd "$HOST"
	git_c fetch --quiet origin main
	git_c reset --hard --quiet origin/main)

echo "6. A commit stranded by a failed push is retried on the next run..."
# The bug this covers: after a failed push the commit sits at HEAD with a clean
# index, so a run that only asked "is anything staged?" would report nothing to
# do and leave published posts unpushed indefinitely — while host-code-update.sh
# refused every deploy over the local commit upstream lacks.
#
# Simulated by committing locally without pushing, exactly the state a network
# or auth failure leaves behind.
printf -- '---\ntitle: stranded\n---\n' >"$HOST/content/published/2026-01-05-stranded.md"
# Staged by path, not `add -A`: this fixture has the script copied into
# scripts/ untracked, and sweeping it in would make this a mixed commit that
# case 8's guard rightly refuses — testing the wrong thing.
(cd "$HOST"
	git_c add content/published
	git_c commit --quiet -m "content: stranded by a failed push")
if upstream_has content/published/2026-01-05-stranded.md; then
	echo "FAIL: fixture is wrong, the post is already upstream"; exit 1
fi
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0, got $CODE"; echo "$OUT"; exit 1; }
upstream_has content/published/2026-01-05-stranded.md || {
	echo "FAIL: the stranded commit was never pushed"; echo "$OUT"; exit 1; }
echo "OK: an unpushed commit is retried, not reported as nothing to do."

echo "7. A dirty index is refused rather than swept into the commit..."
# `git commit` records the whole index, not just the paths we staged. Anything
# an operator or an interrupted git left staged would otherwise ride along into
# an unattended push to main.
printf 'unrelated\n' >"$HOST/README-stray.md"
printf -- '---\ntitle: sixth\n---\n' >"$HOST/content/published/2026-01-06-sixth.md"
(cd "$HOST" && git_c add README-stray.md)
run_push
[ "$CODE" -eq 70 ] || { echo "FAIL: expected exit 70, got $CODE"; echo "$OUT"; exit 1; }
if upstream_has README-stray.md; then
	echo "FAIL: an unrelated staged file was pushed"; exit 1
fi
if upstream_has content/published/2026-01-06-sixth.md; then
	echo "FAIL: it committed despite the dirty index"; exit 1
fi
echo "OK: dirty index refused, nothing pushed."

# ...and once the index is clean again the post flows normally, so the refusal
# is a pause rather than a dead end.
(cd "$HOST" && git_c reset --quiet HEAD README-stray.md && rm -f README-stray.md)
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0 after clearing, got $CODE"; echo "$OUT"; exit 1; }
upstream_has content/published/2026-01-06-sixth.md || {
	echo "FAIL: the post did not flow after the index was cleared"; exit 1; }
echo "OK: clearing the index resumes publishing."

echo "8. A local commit touching more than content is refused, not pushed..."
# The ancestry check that rescues a stranded commit cannot, on its own, tell a
# stranded content commit from someone debugging on this shared host. Without
# this guard the next timer tick would push their work to main unattended.
mkdir -p "$HOST/src"
printf 'debugging\n' >"$HOST/src/scratch.txt"
(cd "$HOST"
	git_c add src/scratch.txt
	git_c commit --quiet -m "wip: someone poking at the host")
run_push
[ "$CODE" -eq 71 ] || { echo "FAIL: expected exit 71, got $CODE"; echo "$OUT"; exit 1; }
if upstream_has src/scratch.txt; then
	echo "FAIL: an unrelated commit was pushed to upstream"; exit 1
fi
case "$OUT" in
	*src/scratch.txt*) ;;
	*) echo "FAIL: the refusal does not name the offending path: $OUT"; exit 1 ;;
esac
echo "OK: non-content commits are refused."

# A content post committed alongside it must not sneak through either: the
# guard covers the whole range, not just the newest commit.
printf -- '---\ntitle: seventh\n---\n' >"$HOST/content/published/2026-01-07-seventh.md"
run_push
[ "$CODE" -eq 71 ] || { echo "FAIL: expected exit 71, got $CODE"; echo "$OUT"; exit 1; }
if upstream_has content/published/2026-01-07-seventh.md; then
	echo "FAIL: a post rode out alongside the unrelated commit"; exit 1
fi
echo "OK: the whole range is checked, not just the tip."

# Dropping the stray commit lets the backlog flow again.
(cd "$HOST" && git_c reset --hard --quiet origin/main)
printf -- '---\ntitle: seventh\n---\n' >"$HOST/content/published/2026-01-07-seventh.md"
run_push
[ "$CODE" -eq 0 ] || { echo "FAIL: expected exit 0 after dropping it, got $CODE"; echo "$OUT"; exit 1; }
upstream_has content/published/2026-01-07-seventh.md || {
	echo "FAIL: publishing did not resume"; exit 1; }
echo "OK: dropping the stray commit resumes publishing."

echo "9. Stray commits that cancel each other out are still refused..."
# The guard reads each commit, not the net diff of the range. Someone debugging
# who edits a file, commits, then reverts it and commits again leaves a range
# whose net diff is empty — and a net-diff check would wave their WIP straight
# into main's history.
mkdir -p "$HOST/src"  # the reset above pruned it along with the stray commit
printf 'debugging\n' >"$HOST/src/scratch.txt"
(cd "$HOST"
	git_c add src/scratch.txt
	git_c commit --quiet -m "wip: poking again"
	git_c rm --quiet src/scratch.txt
	git_c commit --quiet -m "wip: never mind")
[ -z "$(git_c -C "$HOST" diff --name-only origin/main...HEAD)" ] || {
	echo "FAIL: fixture is wrong, the range does not net out to empty"; exit 1; }
run_push
[ "$CODE" -eq 71 ] || { echo "FAIL: expected exit 71, got $CODE"; echo "$OUT"; exit 1; }
case "$OUT" in
	*src/scratch.txt*) ;;
	*) echo "FAIL: the refusal does not name the offending path: $OUT"; exit 1 ;;
esac
echo "OK: a self-cancelling pair of stray commits is still caught."

echo ""
echo "All push-posts tests passed!"
