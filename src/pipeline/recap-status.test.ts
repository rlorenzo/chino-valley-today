import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db/index.ts";
import { recapStatus } from "./recap-status.ts";

const LEGISTAR = "https://chino.legistar.com";
// Friday Nov 13, 2026, 09:00 Pacific: when the Friday reminder reads /health.
const FRIDAY = new Date("2026-11-13T17:00:00Z");

function seed(): ReturnType<typeof openDb> {
	const db = openDb(":memory:");
	db.raw.exec(`
		INSERT OR IGNORE INTO sources (key, name, base_url, method)
		  VALUES ('chino-legistar', 'Chino Legistar', '${LEGISTAR}', 'api');
		INSERT INTO documents (id, source_id, url, doc_type, fetched_at, content_hash, raw_path)
		  SELECT 1, id, '${LEGISTAR}/m', 'agenda', '2026-11-01', 'h', 'x'
		  FROM sources WHERE key = 'chino-legistar';
	`);
	const item = db.raw.prepare(
		`INSERT INTO items (document_id, source_url, item_type, external_id, title, meta, occurred_at)
		 VALUES (1, ?, ?, ?, 'Item', '{}', ?)`,
	);
	const meeting = (day: string, withVote: boolean) => {
		item.run(`${LEGISTAR}/a-${day}`, "agenda_item", `a-${day}`, day);
		if (withVote) item.run(`${LEGISTAR}/v-${day}`, "vote", `v-${day}`, day);
	};
	meeting("2026-11-03", true); // votes, no recap: ready
	meeting("2026-10-20", false); // agenda only: waiting
	meeting("2026-10-06", true); // votes, but a rejected recap exists: decided
	meeting("2026-09-01", true); // votes, but outside the 45-day window
	meeting("2026-11-17", false); // future agenda: not late, not counted

	const post = db.raw.prepare(
		`INSERT INTO posts (slug, post_type, tier, status, file_path, created_at)
		 VALUES (?, ?, 'B', ?, 'content/x.md', '2026-11-01')`,
	);
	post.run("2026-10-06-chino-city-council-recap", "meeting_recap", "rejected");
	post.run(
		"2026-08-11-chino-hills-city-council-recap",
		"meeting_recap",
		"held",
	);
	post.run("2026-11-02-held-preview", "meeting_preview", "held"); // not a recap
	return db;
}

test("counts ready, waiting and held recaps by the skill's rule", () => {
	assert.deepEqual(recapStatus(seed(), FRIDAY), {
		ready: 1,
		held: 1,
		waiting: 1,
	});
});

test("a published recap takes its meeting out of ready", () => {
	const db = seed();
	db.raw
		.prepare(
			`INSERT INTO posts (slug, post_type, tier, status, file_path, created_at)
			 VALUES ('2026-11-03-chino-city-council-recap', 'meeting_recap', 'B', 'published', 'content/y.md', '2026-11-04')`,
		)
		.run();
	assert.equal(recapStatus(db, FRIDAY).ready, 0);
});

test("an empty database reads all zeros, not an error", () => {
	assert.deepEqual(recapStatus(openDb(":memory:"), FRIDAY), {
		ready: 0,
		held: 0,
		waiting: 0,
	});
});
