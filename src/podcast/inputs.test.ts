import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { createPost, type NewPost, transitionPost } from "../pipeline/posts.ts";
import { ROOT } from "../store.ts";
import { laDatePlusDays, pacificDay, podcastInputs } from "./inputs.ts";

const MONDAY = pacificDay("2026-09-07");
const SOURCE = "https://chino.gov/agenda/1";

// Slugs are namespaced so a test file left behind by a crash is obviously ours
// and never collides with real content under content/.
const SLUG_PREFIX = "podcast-inputs-test";

function publish(
	db: ReturnType<typeof openDb>,
	name: string,
	publishedAt: string,
	over: Partial<NewPost> = {},
): string {
	const slug = `${SLUG_PREFIX}-${name}`;
	createPost(db, {
		slug,
		postType: "meeting_preview",
		tier: "A",
		title: `Title for ${name}`,
		bodyMd: `Body for ${name}. The vote was 4-1.`,
		sources: [SOURCE],
		...over,
	});
	transitionPost(db, slug, "published");
	// transitionPost stamps published_at with the wall clock; the window is the
	// thing under test, so it is set explicitly.
	db.raw
		.prepare("UPDATE posts SET published_at = ? WHERE slug = ?")
		.run(publishedAt, slug);
	return slug;
}

function cleanup(slugs: string[]): void {
	for (const slug of slugs) {
		for (const dir of ["queue", "published", "held"]) {
			rmSync(join(ROOT, "content", dir, `${slug}.md`), { force: true });
		}
	}
}

function addEvent(
	db: ReturnType<typeof openDb>,
	sourceKey: string,
	id: string,
	occurredAt: string,
	title: string,
): void {
	const sourceId = db.upsertSource({
		key: sourceKey,
		name: sourceKey,
		base_url: `https://example.org/${sourceKey}`,
		method: "html",
	});
	const doc = db.insertDocument({
		source_id: sourceId,
		url: `https://example.org/${sourceKey}/${id}`,
		doc_type: "calendar",
		content_hash: `hash-${id}`,
		raw_path: "/raw/path",
	});
	db.insertItem({
		document_id: doc.id,
		source_url: `https://example.org/${sourceKey}/${id}`,
		item_type: "event",
		external_id: id,
		title,
		occurred_at: occurredAt,
	});
}

describe("podcastInputs — last week's posts", () => {
	test("takes the seven Pacific days before the episode Monday, and no others", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			// Pacific days: the window is [2026-08-31, 2026-09-07).
			slugs.push(publish(db, "too-old", "2026-08-31T06:00:00.000Z")); // Aug 30 PT
			slugs.push(publish(db, "first-day", "2026-08-31T18:00:00.000Z")); // Aug 31 PT
			slugs.push(publish(db, "midweek", "2026-09-03T14:00:00.000Z")); // Sep 3 PT
			slugs.push(publish(db, "last-day", "2026-09-07T06:00:00.000Z")); // Sep 6 PT
			slugs.push(publish(db, "episode-day", "2026-09-07T18:00:00.000Z")); // Sep 7 PT

			const { posts } = podcastInputs(db, MONDAY);
			assert.deepEqual(
				posts.map((p) => p.slug),
				[
					`${SLUG_PREFIX}-first-day`,
					`${SLUG_PREFIX}-midweek`,
					`${SLUG_PREFIX}-last-day`,
				],
			);
		} finally {
			cleanup(slugs);
		}
	});

	test("skips the daily brief and last week's own episode", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			slugs.push(
				publish(db, "brief", "2026-09-03T14:00:00.000Z", {
					postType: "daily-brief",
				}),
			);
			slugs.push(
				publish(db, "episode", "2026-09-03T14:00:00.000Z", {
					postType: "podcast",
				}),
			);
			slugs.push(publish(db, "story", "2026-09-03T14:00:00.000Z"));

			assert.deepEqual(
				podcastInputs(db, MONDAY).posts.map((p) => p.slug),
				[`${SLUG_PREFIX}-story`],
			);
		} finally {
			cleanup(slugs);
		}
	});

	test("skips a post that is queued, held or rejected", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			const held = publish(db, "held", "2026-09-03T14:00:00.000Z");
			slugs.push(held);
			transitionPost(db, held, "held", { heldReason: "gate1: numeric" });
			slugs.push(publish(db, "kept", "2026-09-03T14:00:00.000Z"));

			assert.deepEqual(
				podcastInputs(db, MONDAY).posts.map((p) => p.slug),
				[`${SLUG_PREFIX}-kept`],
			);
		} finally {
			cleanup(slugs);
		}
	});

	test("mints the public URL the site actually routes, and strips frontmatter", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			slugs.push(publish(db, "story", "2026-09-03T14:00:00.000Z"));
			const [post] = podcastInputs(db, MONDAY).posts;
			assert.equal(
				post.url,
				`https://chinovalley.today/posts/${SLUG_PREFIX}-story/`,
			);
			assert.equal(post.title, "Title for story");
			assert.match(post.bodyMd, /Body for story\. The vote was 4-1\./);
			assert.doesNotMatch(post.bodyMd, /^---/);
			assert.doesNotMatch(post.bodyMd, /post_type:/);
		} finally {
			cleanup(slugs);
		}
	});

	test("an ISO-week slug is filed and cited at the same lowercased address", () => {
		// createPost lowercases the slug because Astro's loader lowercases the
		// filename; a citation built from the caller's spelling would 404.
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			createPost(db, {
				slug: `${SLUG_PREFIX}-2026-W36-digest`,
				postType: "news_digest",
				tier: "A",
				title: "Digest",
				bodyMd: "Body.",
				sources: [SOURCE],
			});
			const lower = `${SLUG_PREFIX}-2026-w36-digest`;
			slugs.push(lower);
			transitionPost(db, lower, "published");
			db.raw
				.prepare("UPDATE posts SET published_at = ? WHERE slug = ?")
				.run("2026-09-03T14:00:00.000Z", lower);

			assert.equal(
				podcastInputs(db, MONDAY).posts[0].url,
				`https://chinovalley.today/posts/${lower}/`,
			);
		} finally {
			cleanup(slugs);
		}
	});
});

describe("podcastInputs — the week ahead", () => {
	test("covers the episode Monday through the following Sunday", () => {
		const db = openDb(":memory:");
		// selectUpcomingEvents reads the Pacific day of occurred_at; 20:00Z is
		// mid-afternoon Pacific on the same day year-round.
		addEvent(
			db,
			"sbclib-events",
			"before",
			"2026-09-06T20:00:00.000Z",
			"Sunday before",
		);
		addEvent(
			db,
			"sbclib-events",
			"monday",
			"2026-09-07T20:00:00.000Z",
			"Episode Monday",
		);
		addEvent(
			db,
			"sbclib-events",
			"sunday",
			"2026-09-13T20:00:00.000Z",
			"Closing Sunday",
		);
		addEvent(
			db,
			"sbclib-events",
			"after",
			"2026-09-14T20:00:00.000Z",
			"Next Monday",
		);

		assert.deepEqual(
			podcastInputs(db, MONDAY).events.map((e) => e.title),
			["Episode Monday", "Closing Sunday"],
		);
	});

	test("reads only the calendars the daily brief reads", () => {
		const db = openDb(":memory:");
		addEvent(
			db,
			"sbclib-events",
			"lib",
			"2026-09-08T20:00:00.000Z",
			"Library event",
		);
		// cvusd-board events are board meetings, handled by the meetings selector
		// rather than the calendar rail, so they are not a calendar source.
		addEvent(
			db,
			"cvusd-board",
			"board",
			"2026-09-08T20:00:00.000Z",
			"Board meeting",
		);

		assert.deepEqual(
			podcastInputs(db, MONDAY).events.map((e) => e.title),
			["Library event"],
		);
	});

	test("carries the event's own URL, which is what a turn may cite", () => {
		const db = openDb(":memory:");
		addEvent(
			db,
			"sbclib-events",
			"lib",
			"2026-09-08T20:00:00.000Z",
			"Library event",
		);
		assert.equal(
			podcastInputs(db, MONDAY).events[0].url,
			"https://example.org/sbclib-events/lib",
		);
	});

	test("is empty rather than throwing when no calendar has anything", () => {
		assert.deepEqual(podcastInputs(openDb(":memory:"), MONDAY).events, []);
	});
});

describe("date helpers", () => {
	test("pacificDay lands on the same calendar day in Pacific and in UTC", () => {
		for (const day of ["2026-01-05", "2026-07-06", "2026-11-02"]) {
			const d = pacificDay(day);
			assert.equal(d.toISOString().slice(0, 10), day, `UTC day for ${day}`);
			assert.equal(
				new Intl.DateTimeFormat("en-CA", {
					timeZone: "America/Los_Angeles",
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
				}).format(d),
				day,
				`Pacific day for ${day}`,
			);
		}
	});

	test("laDatePlusDays crosses months, years and a DST boundary", () => {
		assert.equal(laDatePlusDays("2026-09-07", -7), "2026-08-31");
		assert.equal(laDatePlusDays("2026-12-28", 7), "2027-01-04");
		// Pacific falls back on 2026-11-01; calendar-day math must not shift.
		assert.equal(laDatePlusDays("2026-10-26", 7), "2026-11-02");
	});
});
