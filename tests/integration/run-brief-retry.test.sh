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

echo "4. Testing retry failure when one source is failing..."
STALE_DB="$TMP_DIR/stale.db"
cp "$TEST_DB" "$STALE_DB"

CVT_DB="$STALE_DB" node --input-type=module -e '
import { openDb } from "./src/db/index.ts";

const db = openDb(process.env.CVT_DB);
const nowIso = new Date().toISOString();

db.raw.prepare(`
	INSERT INTO scrape_runs (source_key, started_at, finished_at, status, error_message)
	VALUES (?, ?, ?, ?, ?)
`).run("sbcfire-news", nowIso, nowIso, "failure", "HTTP 500 error");
'

if CVT_DB="$STALE_DB" node src/pipeline/daily-brief.ts --check-prereqs >/dev/null 2>&1; then
	echo "FAIL: Expected --check-prereqs to fail when sbcfire-news failed, but it succeeded." >&2
	exit 1
fi
echo "OK: Failed as expected when sbcfire-news is failing."

echo "5. Testing run-brief.sh retry exhaustion and exit code 1..."
if CVT_DB="$STALE_DB" CVT_PREREQ_MAX_ATTEMPTS=2 CVT_PREREQ_RETRY_DELAY_SEC=0 bash scripts/run-brief.sh >/dev/null 2>&1; then
	echo "FAIL: Expected run-brief.sh to fail with exit code 1 on stale DB, but it succeeded." >&2
	exit 1
fi
echo "OK: run-brief.sh exited with failure on stale prerequisites."

echo "All run-brief retry integration tests passed!"
