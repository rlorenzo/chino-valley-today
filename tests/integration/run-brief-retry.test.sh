#!/usr/bin/env bash
# Integration test for scripts/run-brief.sh and --check-prereqs retry behavior.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TEST_DB="$TMP_DIR/test.db"

echo "1. Testing --check-prereqs against empty database (should fail)..."
if CVT_DB="$TEST_DB" node src/pipeline/daily-brief.ts --check-prereqs >/dev/null 2>&1; then
	echo "FAIL: Expected --check-prereqs to fail on empty DB, but it succeeded." >&2
	exit 1
fi
echo "OK: Failed as expected on empty database."

echo "2. Populating all 15 prerequisite sources with fresh successful runs..."
# shellcheck disable=SC2016
CVT_DB="$TEST_DB" node --input-type=module -e '
import { openDb } from "./src/db/index.ts";
import { DAILY_BRIEF_PREREQUISITE_SOURCES, laDateOf } from "./src/pipeline/daily-brief.ts";

const db = openDb(process.env.CVT_DB);
const now = new Date();
const nowIso = now.toISOString();

for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
	const sourceId = db.upsertSource({
		key,
		name: key,
		base_url: `https://example.org/${key}`,
		method: "html",
	});

	db.raw.prepare(`
		INSERT INTO scrape_runs (source_key, started_at, finished_at, status, documents_count, items_count)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(key, nowIso, nowIso, "success", 1, 1);

	db.raw.prepare(`
		INSERT INTO documents (source_id, url, doc_type, fetched_at, content_hash, raw_path)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(sourceId, `https://example.org/${key}/doc`, "agenda", nowIso, "hash", "/raw/path");
}
'

echo "3. Testing --check-prereqs against fully populated database (should succeed)..."
if ! CVT_DB="$TEST_DB" node src/pipeline/daily-brief.ts --check-prereqs; then
	echo "FAIL: Expected --check-prereqs to succeed on fresh DB, but it failed." >&2
	exit 1
fi
echo "OK: Succeeded as expected on fresh database."

# Fails one source and reports whether --check-prereqs exited non-zero.
fail_source() {
	local key="$1" db="$2"
	cp "$TEST_DB" "$db"
	CVT_DB="$db" CVT_FAIL_KEY="$key" node --input-type=module -e '
import { openDb } from "./src/db/index.ts";

const db = openDb(process.env.CVT_DB);
const nowIso = new Date().toISOString();

db.raw.prepare(`
	INSERT INTO scrape_runs (source_key, started_at, finished_at, status, error_message)
	VALUES (?, ?, ?, ?, ?)
`).run(process.env.CVT_FAIL_KEY, nowIso, nowIso, "failure", "HTTP 500 error");
'
}

echo "4. Testing an OPTIONAL source failing degrades but does not block..."
# sbcfire-news is optional since the tiering in PR #33: the brief must still
# publish, warn about the degraded source, and exit 0. Before tiering this
# case blocked the brief, which is the 2026-08-20 cbwcd.org outage.
DEGRADED_DB="$TMP_DIR/degraded.db"
fail_source "sbcfire-news" "$DEGRADED_DB"

if ! out="$(CVT_DB="$DEGRADED_DB" node src/pipeline/daily-brief.ts --check-prereqs 2>&1)"; then
	echo "FAIL: an optional source failing must not block the brief. Got: $out" >&2
	exit 1
fi
case "$out" in
*"degraded (optional): sbcfire-news"*) ;;
*)
	echo "FAIL: expected a degraded warning naming sbcfire-news, got: $out" >&2
	exit 1
	;;
esac
echo "OK: optional failure degraded with a warning and exited 0."

echo "4b. Testing a BLOCKING source failing still holds the brief..."
STALE_DB="$TMP_DIR/stale.db"
fail_source "nws-alerts" "$STALE_DB"

if CVT_DB="$STALE_DB" node src/pipeline/daily-brief.ts --check-prereqs >/dev/null 2>&1; then
	echo "FAIL: Expected --check-prereqs to fail when nws-alerts failed, but it succeeded." >&2
	exit 1
fi
echo "OK: Failed as expected when nws-alerts is failing."

echo "5. Testing run-brief.sh retry exhaustion and exit code 1 (blocking source)..."
if CVT_DB="$STALE_DB" CVT_PREREQ_MAX_ATTEMPTS=2 CVT_PREREQ_RETRY_DELAY_SEC=0 bash scripts/run-brief.sh >/dev/null 2>&1; then
	echo "FAIL: Expected run-brief.sh to fail with exit code 1 on stale DB, but it succeeded." >&2
	exit 1
fi
echo "OK: run-brief.sh exited with failure on stale prerequisites."

echo "All run-brief retry integration tests passed!"
