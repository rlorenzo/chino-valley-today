#!/usr/bin/env bash
# Integration test for the unit-install half of scripts/check-code-drift.sh:
# a repo-shipped systemd unit that is missing from the installed dir, differs
# from it, or is installed but not running must fail the check and mark the
# live health file; a clean host must pass without touching it.
#
# Everything runs against fixtures: a throwaway upstream repo stands in for
# origin (so `git ls-remote origin` needs no network), fixture directories
# stand in for deploy/systemd and /etc/systemd/system, and a stubbed
# `systemctl` on PATH answers is-active from a list file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Keep the operator's real git config (signing, hooks) out of the fixtures.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
git_c() { git -c user.name=test -c user.email=test@test -c commit.gpgsign=false "$@"; }

echo "0. Building fixtures..."

# A two-commit upstream and a clone of it: the clone is "the host checkout",
# and its origin is the local upstream, so the script's ls-remote works
# offline. The script refuses to run outside a checkout root with a scripts/
# dir, so the fixture repo carries one.
UPSTREAM="$TMP_DIR/upstream"
HOST="$TMP_DIR/host"
mkdir -p "$UPSTREAM"
git_c -C "$UPSTREAM" init -q -b main
mkdir "$UPSTREAM/scripts"
echo one >"$UPSTREAM/scripts/placeholder"
git_c -C "$UPSTREAM" add -A && git_c -C "$UPSTREAM" commit -qm first
echo two >"$UPSTREAM/scripts/placeholder"
git_c -C "$UPSTREAM" add -A && git_c -C "$UPSTREAM" commit -qm second
git_c clone -q "$UPSTREAM" "$HOST"

# Repo units and their installed copies, in sync to start.
UNITS="$TMP_DIR/repo-units"
INSTALLED="$TMP_DIR/installed"
mkdir -p "$UNITS" "$INSTALLED"
printf '[Unit]\nDescription=a\n' >"$UNITS/cvt-a.service"
printf '[Timer]\nOnCalendar=hourly\n' >"$UNITS/cvt-b.timer"
cp "$UNITS/cvt-a.service" "$UNITS/cvt-b.timer" "$INSTALLED/"

# The live health file the script marks on drift.
WEB="$TMP_DIR/web"
mkdir -p "$WEB/current"
reset_health() { printf 'built=test\npipeline=fresh\n' >"$WEB/current/health"; }
reset_health
HEALTH="$WEB/current/health"

# systemctl stub: is-active answers from a list of inactive unit names.
STUB_BIN="$TMP_DIR/bin"
INACTIVE_LIST="$TMP_DIR/inactive-units"
mkdir -p "$STUB_BIN"
: >"$INACTIVE_LIST"
cat >"$STUB_BIN/systemctl" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "is-active" ]; then
	shift
	[ "\$1" = "--quiet" ] && shift
	grep -qxF "\$1" "$INACTIVE_LIST" && exit 3
	exit 0
fi
exit 0
STUB
chmod +x "$STUB_BIN/systemctl"

run_check() {
	(
		cd "$HOST" &&
			PATH="$STUB_BIN:$PATH" \
				CVT_UNITS_DIR="$UNITS" \
				CVT_SYSTEMD_DIR="$INSTALLED" \
				CVT_WEB_ROOT="$WEB" \
				bash "$ROOT/scripts/check-code-drift.sh"
	)
}

echo "1. Clean host (units in sync, timers active) should pass..."
out="$(run_check)"
case "$out" in
*"ok: checkout matches origin/main"*) ;;
*)
	echo "FAIL: expected an ok line, got: $out" >&2
	exit 1
	;;
esac
if ! grep -qx 'pipeline=fresh' "$HEALTH" || grep -q '^units=drifted' "$HEALTH"; then
	echo "FAIL: clean run must leave the health file untouched" >&2
	exit 1
fi
echo "OK: passed and health untouched."

echo "2. A repo unit missing from the installed dir should fail..."
rm "$INSTALLED/cvt-b.timer"
if err="$(run_check 2>&1)"; then
	echo "FAIL: expected a missing unit to fail the check" >&2
	exit 1
fi
case "$err" in
*"not installed: cvt-b.timer"*) ;;
*)
	echo "FAIL: expected the missing unit to be named, got: $err" >&2
	exit 1
	;;
esac
grep -qx 'pipeline=stale' "$HEALTH" || { echo "FAIL: health not flipped to stale" >&2; exit 1; }
grep -q '^units=drifted missing=cvt-b.timer$' "$HEALTH" || { echo "FAIL: missing marker wrong: $(cat "$HEALTH")" >&2; exit 1; }
cp "$UNITS/cvt-b.timer" "$INSTALLED/"
reset_health
echo "OK: failed, named the unit, marked health."

echo "3. An installed unit that differs from the repo should fail..."
echo "# local edit" >>"$INSTALLED/cvt-a.service"
if err="$(run_check 2>&1)"; then
	echo "FAIL: expected a differing unit to fail the check" >&2
	exit 1
fi
case "$err" in
*"differ from repo: cvt-a.service"*) ;;
*)
	echo "FAIL: expected the differing unit to be named, got: $err" >&2
	exit 1
	;;
esac
grep -q '^units=drifted differ=cvt-a.service$' "$HEALTH" || { echo "FAIL: differ marker wrong: $(cat "$HEALTH")" >&2; exit 1; }

echo "4. The marker must stay a single line across repeated runs..."
run_check 2>/dev/null || true
run_check 2>/dev/null || true
if [ "$(grep -c '^units=drifted' "$HEALTH")" != 1 ]; then
	echo "FAIL: repeated runs stacked units=drifted lines: $(cat "$HEALTH")" >&2
	exit 1
fi
cp "$UNITS/cvt-a.service" "$INSTALLED/"
reset_health
echo "OK: idempotent."

echo "5. An installed-but-inactive timer should fail..."
echo "cvt-b.timer" >"$INACTIVE_LIST"
if err="$(run_check 2>&1)"; then
	echo "FAIL: expected an inactive timer to fail the check" >&2
	exit 1
fi
case "$err" in
*"not running: cvt-b.timer"*) ;;
*)
	echo "FAIL: expected the inactive timer to be named, got: $err" >&2
	exit 1
	;;
esac
grep -q '^units=drifted inactive=cvt-b.timer$' "$HEALTH" || { echo "FAIL: inactive marker wrong: $(cat "$HEALTH")" >&2; exit 1; }
: >"$INACTIVE_LIST"
reset_health
echo "OK: failed and named it."

echo "6. An installed cvt-* unit the repo does not ship is a note, not a failure..."
printf '[Timer]\n' >"$INSTALLED/cvt-orphan.timer"
out="$(run_check)"
case "$out" in
*"not in repo"*"cvt-orphan.timer"*) ;;
*)
	echo "FAIL: expected an orphan note, got: $out" >&2
	exit 1
	;;
esac
grep -qx 'pipeline=fresh' "$HEALTH" || { echo "FAIL: an orphan note must not mark health" >&2; exit 1; }
rm "$INSTALLED/cvt-orphan.timer"
echo "OK: noted without failing."

echo "7. Code drift still fails and marks health on its own..."
git_c -C "$HOST" reset -q --hard HEAD~1
if err="$(run_check 2>&1)"; then
	echo "FAIL: expected a behind checkout to fail the check" >&2
	exit 1
fi
case "$err" in
*"checkout does not match origin/main"*) ;;
*)
	echo "FAIL: expected the code-drift message, got: $err" >&2
	exit 1
	;;
esac
grep -q '^code=drifted ' "$HEALTH" || { echo "FAIL: code marker missing: $(cat "$HEALTH")" >&2; exit 1; }
if grep -q '^units=drifted' "$HEALTH"; then
	echo "FAIL: units marker written with units in sync: $(cat "$HEALTH")" >&2
	exit 1
fi
echo "OK: code drift path intact."

echo "8. No installed-units directory skips the unit check cleanly..."
# The report says "unit-install check skipped" on this path, so it must not
# also print an orphan note: with installed_dir emptied, the orphan glob used
# to expand to /cvt-* and scan the filesystem root. Restore the checkout first
# (case 7 left it behind) so this exercises the skip path, not code drift.
git_c -C "$HOST" reset -q --hard "$(git_c -C "$UPSTREAM" rev-parse main)"
: >"$HEALTH"
echo 'pipeline=fresh' >"$HEALTH"
out="$(
	cd "$HOST" &&
		PATH="$STUB_BIN:$PATH" \
			CVT_UNITS_DIR="$UNITS" \
			CVT_SYSTEMD_DIR="$TMP_DIR/no-such-systemd-dir" \
			CVT_WEB_ROOT="$WEB" \
			bash "$ROOT/scripts/check-code-drift.sh"
)"
case "$out" in
*"skipping the unit-install check"*) ;;
*)
	echo "FAIL: expected the skip note, got: $out" >&2
	exit 1
	;;
esac
case "$out" in
*"not in repo"*)
	echo "FAIL: skipped unit check must not emit an orphan note, got: $out" >&2
	exit 1
	;;
esac
grep -qx 'pipeline=fresh' "$HEALTH" || { echo "FAIL: skip path must not mark health" >&2; exit 1; }
echo "OK: skipped without scanning for orphans."

echo "All checks passed."
