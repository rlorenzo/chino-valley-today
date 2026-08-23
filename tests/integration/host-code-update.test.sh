#!/usr/bin/env bash
# Integration test for the published-content guard in
# scripts/host-code-update.sh: a reset that would LOSE published content must
# be refused, and one that merely brings the checkout up to date must not be.
#
# The second half is the regression. On 2026-08-23 Task 4.5 committed a
# `topics:` block onto seven published posts; the host had no edits of its own,
# so the reset would have lost nothing — but the guard compared the working
# tree against origin/main, which differs whenever GIT moves too, and every
# deploy failed until someone fast-forwarded the checkout by hand.
#
# Everything runs against fixtures: a throwaway upstream stands in for origin,
# and npm is stubbed so `npm ci` never runs for real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
git_c() { git -c user.name=test -c user.email=test@test -c commit.gpgsign=false "$@"; }

# `npm ci` must not reach the network; the guard is what is under test.
STUB_BIN="$TMP_DIR/bin"
mkdir -p "$STUB_BIN"
printf '#!/usr/bin/env bash\nexit 0\n' >"$STUB_BIN/npm"
chmod +x "$STUB_BIN/npm"
export PATH="$STUB_BIN:$PATH"

UPSTREAM="$TMP_DIR/upstream"
HOST="$TMP_DIR/host"

# HOME is where the guard writes its diverged-content backup.
export HOME="$TMP_DIR/home"
mkdir -p "$HOME"

build_fixtures() {
	# $HOME too: each case asserts on the backups IT wrote, not a leftover set.
	rm -rf "$UPSTREAM" "$HOST" "$HOME/diverged-content"
	mkdir -p "$UPSTREAM/content/published" "$UPSTREAM/scripts"
	git_c -C "$UPSTREAM" init -q -b main
	printf -- '---\ntitle: "A"\n---\n\nBody.\n' >"$UPSTREAM/content/published/post-a.md"
	echo placeholder >"$UPSTREAM/scripts/placeholder"
	git_c -C "$UPSTREAM" add -A
	git_c -C "$UPSTREAM" commit -qm first
	git_c clone -q "$UPSTREAM" "$HOST"
	cp "$ROOT/scripts/host-code-update.sh" "$HOST/scripts/"
}

fail() { echo "FAIL: $1" >&2; exit 1; }

# Runs the guard, leaving its combined output in $guard_out and its status in
# $guard_status. Never trips `set -e`: a refusal is the expected result half
# the time here.
guard_out=""
guard_status=0
run_guard() {
	guard_status=0
	guard_out="$(cd "$HOST" && bash scripts/host-code-update.sh 2>&1)" ||
		guard_status=$?
}

expect_deploy() {
	run_guard
	[ "$guard_status" -eq 0 ] || fail "$1 (exit $guard_status): $guard_out"
}

# 75 is EX_TEMPFAIL, and it is the whole signal the guard sends a deploy: a
# plain `exit 1` would be indistinguishable from the script itself breaking.
expect_refused() {
	run_guard
	[ "$guard_status" -eq 75 ] || fail "$1 (exit $guard_status): $guard_out"
}

echo "1. A clean checkout already at origin/main deploys..."
build_fixtures
expect_deploy "a clean, up-to-date checkout was refused"
echo "OK: clean checkout accepted."

echo "2. Upstream moving a published post must NOT block (the 4.5 regression)..."
build_fixtures
# Git adds a topics block upstream; the host has no edits of its own.
printf -- '---\ntitle: "A"\ntopics:\n  - safety\n---\n\nBody.\n' \
	>"$UPSTREAM/content/published/post-a.md"
git_c -C "$UPSTREAM" add -A
git_c -C "$UPSTREAM" commit -qm "add topics"
git_c -C "$HOST" fetch -q origin main
expect_deploy "an upstream-only change to a published post blocked the deploy"
grep -q 'topics:' "$HOST/content/published/post-a.md" ||
	fail "the reset did not bring the upstream change down"
echo "OK: host fast-forwarded instead of refusing."

echo "3. Upstream retiring a published post must NOT block either..."
build_fixtures
git_c -C "$UPSTREAM" rm -q content/published/post-a.md
git_c -C "$UPSTREAM" commit -qm "retire post-a"
git_c -C "$HOST" fetch -q origin main
expect_deploy "an upstream deletion of a published post blocked the deploy"
if [ -f "$HOST/content/published/post-a.md" ]; then
	fail "the reset did not apply the upstream deletion"
fi
echo "OK: upstream deletion applied without refusing."

echo "4. A local edit to a published post still blocks..."
build_fixtures
printf -- '---\ntitle: "A"\n---\n\nBody. ~~Wrong~~ Corrected 2026-08-23.\n' \
	>"$HOST/content/published/post-a.md"
expect_refused "a local correction was silently reset away"
grep -q 'would be LOST' <<<"$guard_out" ||
	fail "expected a LOST report, got: $guard_out"
grep -q 'Corrected 2026-08-23' "$HOST/content/published/post-a.md" ||
	fail "the guard refused but the correction was destroyed anyway"
ls "$HOME"/diverged-content/*/post-a.md >/dev/null 2>&1 ||
	fail "no backup copy was written"
echo "OK: local correction preserved and reported."

echo "5. A staged-but-uncommitted edit blocks too..."
build_fixtures
printf -- '---\ntitle: "A"\n---\n\nStaged edit.\n' \
	>"$HOST/content/published/post-a.md"
git_c -C "$HOST" add content/published/post-a.md
expect_refused "a staged edit was not caught"
echo "OK: staged edit caught."

echo "6. A commit made only on the host blocks..."
build_fixtures
printf -- '---\ntitle: "A"\n---\n\nCommitted here only.\n' \
	>"$HOST/content/published/post-a.md"
git_c -C "$HOST" add -A
git_c -C "$HOST" commit -qm "host-only commit"
# Upstream moves too, so HEAD is not an ancestor of origin/main.
echo two >"$UPSTREAM/scripts/placeholder"
git_c -C "$UPSTREAM" add -A
git_c -C "$UPSTREAM" commit -qm second
git_c -C "$HOST" fetch -q origin main
expect_refused "a host-only commit was discarded silently"
echo "OK: host-only commit caught."

echo "7. Untracked and ignored posts never block..."
build_fixtures
printf 'content/published/*-daily-brief.md\n' >"$HOST/.gitignore"
printf -- '---\ntitle: "Brief"\n---\n' \
	>"$HOST/content/published/2026-08-23-daily-brief.md"
printf -- '---\ntitle: "New"\n---\n' >"$HOST/content/published/post-new.md"
expect_deploy "untracked or ignored posts blocked the deploy"
[ -f "$HOST/content/published/post-new.md" ] ||
	fail "the reset destroyed an untracked post"
[ -f "$HOST/content/published/2026-08-23-daily-brief.md" ] ||
	fail "the reset destroyed an ignored brief"
echo "OK: untracked and ignored posts survived and did not block."

echo
echo "All host-code-update guard tests passed!"
