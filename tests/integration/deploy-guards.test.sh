#!/usr/bin/env bash
# Integration test for the guards in scripts/deploy.sh that decide whether a
# command may touch the live site at all.
#
# On 2026-08-24 the live site served a laptop's build for about 90 seconds — 18
# posts instead of 35 — because `deploy.sh all` was `deploy_code; deploy_site`
# and deploy_site builds on the machine you run it from.
#
# Nothing here builds a site. CVT_DEPLOY_HOST is set to a name that does not
# resolve, so the one case that gets as far as SSH (`all`, which starts with
# the code update) stops at the connection — and if a guard ever stopped
# refusing, the test fails there rather than deploying to something real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/scripts/deploy.sh"

# .invalid never resolves (RFC 2606), so an SSH attempt fails immediately
# rather than reaching anything.
export CVT_DEPLOY_HOST="deploy-guard-test.invalid"
# deploy/deploy.env is gitignored and per-operator, and holds the real droplet
# address. Reading one here would aim this test at production.
export CVT_DEPLOY_ENV=/dev/null

# Runs deploy.sh, capturing output and exit code without tripping set -e.
run_deploy() {
	set +e
	OUT="$(bash "$DEPLOY" "$@" 2>&1)"
	CODE=$?
	set -e
}

echo "1. A bare invocation names the subcommands instead of publishing..."
run_deploy
[ "$CODE" -eq 64 ] || { echo "FAIL: expected exit 64, got $CODE"; echo "$OUT"; exit 1; }
case "$OUT" in
	*usage:*) ;;
	*) echo "FAIL: expected a usage message, got: $OUT"; exit 1 ;;
esac
# The old default was `site`, so a bare run built and published. It must not
# reach a build now.
case "$OUT" in
	*"building the site"*) echo "FAIL: a bare run still built the site"; exit 1 ;;
esac
echo "OK: no default subcommand."

echo "2. An unknown subcommand is refused before any configuration..."
run_deploy nonsense
[ "$CODE" -eq 64 ] || { echo "FAIL: expected exit 64, got $CODE"; echo "$OUT"; exit 1; }
echo "OK: unknown subcommand rejected."

echo "2b. ...and 'before any configuration' means before deploy.env is read..."
# An env file that cannot be sourced would abort the script under `set -e`. The
# usage error has to win anyway, or "checked before anything else" is a comment
# rather than a property.
BAD_ENV="$(mktemp)"
trap 'rm -f "$BAD_ENV"' EXIT
printf 'this is not valid bash ((( \n' >"$BAD_ENV"
set +e
OUT="$(CVT_DEPLOY_ENV="$BAD_ENV" bash "$DEPLOY" nonsense 2>&1)"
CODE=$?
set -e
[ "$CODE" -eq 64 ] || { echo "FAIL: expected exit 64, got $CODE"; echo "$OUT"; exit 1; }
case "$OUT" in
	*usage:*) ;;
	*) echo "FAIL: config was read before the subcommand was validated: $OUT"; exit 1 ;;
esac
echo "OK: validated ahead of the env file."

echo "3. 'site' refuses to build locally without the override..."
run_deploy site
[ "$CODE" -eq 79 ] || { echo "FAIL: expected exit 79, got $CODE"; echo "$OUT"; exit 1; }
case "$OUT" in
	*"refusing to build the site on this machine"*) ;;
	*) echo "FAIL: expected the local-build refusal, got: $OUT"; exit 1 ;;
esac
# The refusal has to name the way out, or the next operator finds their own.
case "$OUT" in
	*host-update*) ;;
	*) echo "FAIL: the refusal does not point at the host rebuild: $OUT"; exit 1 ;;
esac
echo "OK: local build refused, with the correct path named."

echo "4. 'all' starts with the code update, not a local build..."
# `all` used to be `deploy_code; deploy_site`, and deploy_site was what
# published a laptop's pages over the host's. It must now reach neither a local
# build nor deploy_site's guard: its first act is deploy_code, which stops here
# on the unresolvable host.
run_deploy all
case "$OUT" in
	*"updating the pipeline checkout"*) ;;
	*) echo "FAIL: 'all' did not start with the code update: $OUT"; exit 1 ;;
esac
case "$OUT" in
	*"building the site"*)
		echo "FAIL: 'all' still builds locally"; exit 1 ;;
	*"refusing to build the site on this machine"*)
		echo "FAIL: 'all' still routes through deploy_site"; exit 1 ;;
esac
[ "$CODE" -ne 0 ] || { echo "FAIL: 'all' reported success against an unreachable host"; exit 1; }
echo "OK: 'all' never reaches the local build path."

echo ""
echo "All deploy guard tests passed!"
