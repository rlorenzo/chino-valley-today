import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { openDb } from "./db/index.ts";
import { ROOT } from "./store.ts";

// run-one.ts is a top-level script that calls process.exit, so it can only be
// exercised as a subprocess -- importing it directly would kill this test
// process. See src/context.test.ts for the in-process invariant coverage of
// the fetch layer this script calls into once past the ToS guard.

let tmpDir: string;
let dbPath: string;
let blockNetworkPreload: string;

const HELD_KEY = "champion-news";
// nws-forecast is a civic/agency source: it carries no publisher-terms
// contract and is not in SOURCE_TOS_REGISTRY, so run-one.ts's gate must never
// consult source_tos_status for it at all (see the scoping comment at
// run-one.ts:21-25). It also fetches with skipRobots: true and issues its
// first request as the very first thing `run` does, which makes it a clean,
// single-message trip of the network-blocking preload once past the gate.
const UNGATED_KEY = "nws-forecast";

before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cvt-run-one-test-"));
	dbPath = join(tmpDir, "test.db");

	// A held source must never reach politeFetch. Rather than trust that by
	// inspection, make any outbound fetch a hard failure: this preload replaces
	// global fetch before run-one.ts (or anything it imports) ever runs, so if
	// the guard is bypassed the subprocess observably throws instead of the
	// test silently passing because nothing happened to notice.
	blockNetworkPreload = join(tmpDir, "block-network.mjs");
	writeFileSync(
		blockNetworkPreload,
		`globalThis.fetch = async (input) => {
			throw new Error("TEST: unexpected network call to " + String(input));
		};\n`,
	);

	// Seed the DB via the same path run-one.ts's own openDb() will seed, then
	// put the champion-news source on hold -- exactly the operator action
	// (setSourceTosHold) that the ToS-drift checker performs in production.
	const db = openDb(dbPath);
	db.setSourceTosHold(HELD_KEY, { reason: "test_hold" });

	// Plant a stray `held` row for the ungated source directly, bypassing
	// SOURCE_TOS_REGISTRY entirely -- openDb never seeds a row for nws-forecast
	// (it isn't in the registry), so this simulates the row existing anyway
	// (e.g. left over, or written by something else) and proves the gate is
	// scoped by registry membership rather than by "does a row exist". The
	// sources row is inserted first only to satisfy source_tos_status's FK;
	// this mirrors openDb's own baseline-seeding pattern in db/index.ts.
	db.raw
		.prepare(
			"INSERT OR IGNORE INTO sources (key, name, base_url, method) VALUES (?, ?, ?, ?)",
		)
		.run(UNGATED_KEY, UNGATED_KEY, "https://api.weather.gov", "api");
	db.raw
		.prepare(
			"INSERT INTO source_tos_status (source_key, status, reviewed_hash, held_reason) VALUES (?, 'held', '', ?)",
		)
		.run(UNGATED_KEY, "stray_row_not_in_registry");
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function countRows(dbFilePath: string, table: string): number {
	const db = openDb(dbFilePath);
	return (
		db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as {
			n: number;
		}
	).n;
}

test("run-one.ts refuses to execute a held scraper", () => {
	const documentsBefore = countRows(dbPath, "documents");
	const itemsBefore = countRows(dbPath, "items");
	const runsBefore = countRows(dbPath, "scrape_runs");

	const result = spawnSync(
		process.execPath,
		["--import", blockNetworkPreload, "src/run-one.ts", HELD_KEY],
		{
			cwd: ROOT,
			// No real backoff in the suite: this drives a civic source whose
			// failure path goes through politeFetch's retry pause.
			env: { ...process.env, CVT_DB: dbPath, CVT_FETCH_RETRY_MS: "0" },
			encoding: "utf8",
		},
	);

	assert.equal(
		result.status,
		1,
		`expected exit code 1, got ${result.status}. stderr:\n${result.stderr}`,
	);
	assert.match(
		result.stderr,
		/Scraper champion-news is HELD due to ToS status \(test_hold\)\. Skipping execution\./,
	);
	// The preload throwing would surface as an uncaught exception in stderr,
	// not as this specific hold message -- so matching the message above
	// already rules out a fetch slipping through. Confirmed directly too:
	assert.doesNotMatch(
		result.stderr,
		/unexpected network call/,
		"no outbound fetch was attempted before the guard exited",
	);

	// No document or item was ever created for the held source.
	assert.equal(
		countRows(dbPath, "documents"),
		documentsBefore,
		"a held source must not produce documents",
	);
	assert.equal(
		countRows(dbPath, "items"),
		itemsBefore,
		"a held source must not produce items",
	);

	// A failed run was recorded so the hold is visible in run history.
	assert.equal(countRows(dbPath, "scrape_runs"), runsBefore + 1);
	const db = openDb(dbPath);
	const run = db.raw
		.prepare(
			"SELECT status, error_message, documents_count, items_count FROM scrape_runs WHERE source_key = ? ORDER BY id DESC LIMIT 1",
		)
		.get(HELD_KEY) as unknown as {
		status: string;
		error_message: string;
		documents_count: number;
		items_count: number;
	};
	assert.equal(run.status, "failure");
	assert.match(
		run.error_message,
		/Scraper held: ToS hold active \(test_hold\)/,
	);
	assert.equal(run.documents_count, 0);
	assert.equal(run.items_count, 0);
});

test("run-one.ts does not gate an ungated civic source, even with a stray held row", () => {
	const result = spawnSync(
		process.execPath,
		["--import", blockNetworkPreload, "src/run-one.ts", UNGATED_KEY],
		{
			cwd: ROOT,
			// No real backoff in the suite: this drives a civic source whose
			// failure path goes through politeFetch's retry pause.
			env: { ...process.env, CVT_DB: dbPath, CVT_FETCH_RETRY_MS: "0" },
			encoding: "utf8",
		},
	);

	// The gate must not have fired: run-one.ts only consults source_tos_status
	// for keys present in SOURCE_TOS_REGISTRY (run-one.ts:21-28), and
	// nws-forecast isn't one, so the stray `held` row planted in before() must
	// be ignored.
	assert.doesNotMatch(
		result.stderr,
		/is HELD due to ToS status/,
		"an ungated source must never be blocked by source_tos_status, stray row or not",
	);

	// Getting past the gate, nws-forecast's `run` immediately calls
	// fetchDocument on api.weather.gov (skipRobots: true, so no robots.txt
	// round trip first), which hits the network-blocking preload and throws.
	// run-one.ts catches that inside def.run's try/catch and exits 1 -- this
	// is the expected, deterministic shape of "the scraper got past the gate
	// and reached real work" under a stubbed network, NOT a bug to fix by
	// stubbing fetch further. It is the proof this test exists to produce.
	assert.equal(
		result.status,
		1,
		`expected exit code 1 (blocked-fetch failure), got ${result.status}. stderr:\n${result.stderr}`,
	);
	assert.match(
		result.stderr,
		/unexpected network call to https:\/\/api\.weather\.gov/,
		"the scraper must have reached its first fetchDocument call, proving it got past the gate",
	);

	const db = openDb(dbPath);
	const run = db.raw
		.prepare(
			"SELECT status, error_message FROM scrape_runs WHERE source_key = ? ORDER BY id DESC LIMIT 1",
		)
		.get(UNGATED_KEY) as unknown as { status: string; error_message: string };
	assert.equal(run.status, "failure");
	assert.match(run.error_message, /unexpected network call/);
});
