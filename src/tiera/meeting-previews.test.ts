import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Db, openDb } from "../db/index.ts";
import {
	generateMeetingPreviews,
	normalizeLocation,
	normalizeTimes,
} from "./meeting-previews.ts";

// generateMeetingPreviews is Tier A: its output is auto-published, and it had no
// tests. It is a pure function of DB state plus an injected `now`, so these seed
// a real in-memory DB rather than mocking the query layer — which also exercises
// tiera/queries.ts.

const NOW = new Date("2026-08-15T12:00:00.000Z");

function seedDb(): Db {
	return openDb(":memory:");
}

function addSource(db: Db, key: string): number {
	return db.upsertSource({
		key,
		name: key,
		base_url: `https://example.test/${key}`,
		method: "html",
	});
}

let hashCounter = 0;
function addEvent(
	db: Db,
	sourceKey: string,
	opts: {
		title: string;
		occurredAt: string | null;
		itemType?: string;
		meta?: Record<string, unknown>;
		docType?: string;
	},
): void {
	const sourceId = addSource(db, sourceKey);
	const hash = String(hashCounter++).padStart(64, "0");
	const doc = db.insertDocument({
		source_id: sourceId,
		url: `https://example.test/${sourceKey}/doc-${hash.slice(-4)}`,
		doc_type: opts.docType ?? "agenda",
		title: "listing",
		content_hash: hash,
		raw_path: `data/raw/00/${hash}.html`,
	}).id;
	db.insertItem({
		document_id: doc,
		source_url: `https://example.test/${sourceKey}/item-${hash.slice(-4)}`,
		item_type: opts.itemType ?? "event",
		external_id: `ext-${hash.slice(-6)}`,
		title: opts.title,
		occurred_at: opts.occurredAt,
		meta: opts.meta,
	});
}

// The City of Chino's calendar feed publishes both of these artifacts. The raw
// archive keeps them verbatim; publishing is where they get corrected.
describe("calendar feed normalisation", () => {
	test("a street run into the city is separated", () => {
		// Their HTML-to-text drops the line break: "AvenueChino".
		assert.equal(
			normalizeLocation("13220 Central AvenueChino, CA 91710"),
			"13220 Central Avenue, Chino, CA 91710",
		);
	});

	test("other street suffixes are handled, and correct addresses are untouched", () => {
		assert.equal(
			normalizeLocation("100 Grand BlvdChino Hills, CA"),
			"100 Grand Blvd, Chino Hills, CA",
		);
		const good = "13220 Central Avenue, Chino, CA 91710";
		assert.equal(
			normalizeLocation(good),
			good,
			"a well-formed address must not be rewritten",
		);
	});

	test("an 11:59 PM end time is dropped, not published as a real end", () => {
		// 11:59 PM is the feed's convention for "no end time specified". Publishing
		// it states a six-hour meeting the source never claimed.
		assert.equal(normalizeTimes("06:00 PM - 11:59 PM"), "06:00 PM");
		assert.equal(
			normalizeTimes("06:00 PM – 11:59 PM"),
			"06:00 PM",
			"en dash too",
		);
	});

	test("a real end time survives untouched", () => {
		assert.equal(normalizeTimes("06:00 PM - 08:00 PM"), "06:00 PM - 08:00 PM");
	});

	test("both are null-safe", () => {
		assert.equal(normalizeLocation(null), null);
		assert.equal(normalizeTimes(null), null);
	});
});

describe("generateMeetingPreviews", () => {
	test("an empty database yields no posts and does not throw", () => {
		const out = generateMeetingPreviews(seedDb(), NOW);
		assert.deepEqual(out.posts, []);
		assert.ok(Array.isArray(out.notes));
	});

	test("a FUTURE meeting produces a preview post", () => {
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "City Council Regular Meeting",
			occurredAt: "2026-08-18T18:00:00.000Z",
		});
		const out = generateMeetingPreviews(db, NOW);
		assert.ok(
			out.posts.length >= 1,
			"a future meeting must generate a preview",
		);
		const post = out.posts[0];
		assert.equal(post.tier, "A");
		assert.equal(post.postType, "meeting_preview");
		assert.ok(post.sources.length > 0, "every post must carry its sources");
	});

	test("the published body carries the normalised location and time", () => {
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "Planning Commission Meeting",
			occurredAt: "2026-08-19T18:00:00.000Z",
			meta: {
				eventDates: "August 19, 2026",
				eventTimes: "06:00 PM - 11:59 PM",
				location: "13220 Central AvenueChino, CA 91710",
			},
		});
		const body = generateMeetingPreviews(db, NOW).posts[0]?.bodyMd ?? "";
		assert.match(body, /13220 Central Avenue, Chino/, "location separated");
		assert.equal(
			body.includes("11:59"),
			false,
			"open-ended marker must not publish",
		);
		assert.match(body, /06:00 PM/, "the start time still publishes");
	});

	test("a PAST meeting produces no preview", () => {
		// The whole point of a preview: previewing a meeting that already happened
		// would be actively misleading to a reader.
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "City Council Regular Meeting",
			occurredAt: "2026-08-01T18:00:00.000Z",
		});
		assert.deepEqual(generateMeetingPreviews(db, NOW).posts, []);
	});

	test("an item with no occurred_at is skipped rather than crashing", () => {
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "Undated meeting",
			occurredAt: null,
		});
		assert.deepEqual(generateMeetingPreviews(db, NOW).posts, []);
	});

	test("an item with an empty title is skipped", () => {
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "   ",
			occurredAt: "2026-08-18T18:00:00.000Z",
		});
		assert.deepEqual(generateMeetingPreviews(db, NOW).posts, []);
	});

	test("every generated post has the fields createPost requires", () => {
		// createPost throws on empty sources, and slug/title/bodyMd are written
		// straight into the markdown file.
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "Planning Commission Meeting",
			occurredAt: "2026-08-19T18:00:00.000Z",
		});
		for (const post of generateMeetingPreviews(db, NOW).posts) {
			assert.ok(post.slug && post.slug.length > 0, "slug");
			assert.ok(post.title && post.title.length > 0, "title");
			assert.ok(post.bodyMd && post.bodyMd.length > 0, "bodyMd");
			assert.ok(post.sources.length > 0, "sources must not be empty");
			assert.match(post.slug, /^[a-z0-9-]+$/, "slug must be url-safe");
		}
	});

	test("slugs are unique across the generated batch", () => {
		// Duplicate slugs collide in the posts table (slug is UNIQUE), so the
		// second would silently overwrite the first.
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "City Council Regular Meeting",
			occurredAt: "2026-08-18T18:00:00.000Z",
		});
		addEvent(db, "chino-news-rss", {
			title: "Planning Commission Meeting",
			occurredAt: "2026-08-19T18:00:00.000Z",
		});
		const slugs = generateMeetingPreviews(db, NOW).posts.map((p) => p.slug);
		assert.equal(new Set(slugs).size, slugs.length, "slugs must be unique");
	});

	test("output is deterministic for the same inputs", () => {
		// Re-running the generator must not produce a different batch, or the same
		// meeting would publish twice under different slugs.
		const db = seedDb();
		addEvent(db, "chino-news-rss", {
			title: "City Council Regular Meeting",
			occurredAt: "2026-08-18T18:00:00.000Z",
		});
		const a = generateMeetingPreviews(db, NOW);
		const b = generateMeetingPreviews(db, NOW);
		assert.deepEqual(
			a.posts.map((p) => p.slug),
			b.posts.map((p) => p.slug),
		);
		assert.deepEqual(
			a.posts.map((p) => p.bodyMd),
			b.posts.map((p) => p.bodyMd),
		);
	});
});
