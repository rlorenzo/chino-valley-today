#!/usr/bin/env bash
# Runs every tests/integration/*.test.sh, in sorted order, and fails on the
# first one that fails.
#
# These suites cover the shell that `npm test` cannot: run-brief.sh's retry and
# prerequisite gating, and check-code-drift.sh's unit-install checks. They were
# written, they were correct, and nothing ever invoked them — `npm test` globs
# only src/**/*.test.ts and scripts/**/*.test.ts, so PR #33 could invert what
# run-brief-retry.test.sh step 4 asserts while the gate stayed green. A test
# that is never invoked reads exactly like a test that passes.
#
# Deliberately not in the pre-commit hook: these shell out to node, git and a
# stubbed systemctl and take seconds, not milliseconds. The gate is the right
# place for them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

shopt -s nullglob
suites=(tests/integration/*.test.sh)
shopt -u nullglob

# An empty glob would otherwise pass silently, which is the exact failure mode
# this script exists to end.
if [ ${#suites[@]} -eq 0 ]; then
	echo "No integration suites found under tests/integration/." >&2
	exit 1
fi

echo "Running ${#suites[@]} integration suite(s)..."
for suite in "${suites[@]}"; do
	echo ""
	echo "=== $suite ==="
	bash "$suite"
done

echo ""
echo "All ${#suites[@]} integration suite(s) passed."
