import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { createPost, type NewPost, transitionPost } from "../pipeline/posts.ts";
import { ROOT } from "../store.ts";
import {
	dedupeEvents,
	laDatePlusDays,
	pacificDay,
	pendingAudioEpisode,
	podcastInputs,
	standingProgramTitles,
} from "./inputs.ts";

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

	test("skips the brief, the digest and last week's own episode", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			slugs.push(
				publish(db, "brief", "2026-09-03T14:00:00.000Z", {
					postType: "daily-brief",
				}),
			);
			slugs.push(
				publish(db, "digest", "2026-09-03T14:00:00.000Z", {
					postType: "news_digest",
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

	test("skips a preview of an event that has not happened yet", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			// Published inside the window, but the event is after the episode
			// Monday, so it is not part of "last week".
			slugs.push(
				publish(db, "future", "2026-09-03T14:00:00.000Z", {
					meetingDate: "2026-09-26",
				}),
			);
			// Same window, an event that already happened: still last week's.
			slugs.push(
				publish(db, "past", "2026-09-03T14:00:00.000Z", {
					postType: "meeting_recap",
					meetingDate: "2026-09-02",
				}),
			);

			assert.deepEqual(
				podcastInputs(db, MONDAY).posts.map((p) => p.slug),
				[`${SLUG_PREFIX}-past`],
			);
		} finally {
			cleanup(slugs);
		}
	});

	test("drops last week's lapsed forecasts but keeps the flood", () => {
		const db = openDb(":memory:");
		const slugs: string[] = [];
		try {
			// Slugs and titles are the shapes the generators really produce:
			// alertPostSlug ends `-alert-<8 hex>`, and generateAlerts prefixes
			// every title with "Weather Alert: " (src/tiera/alerts.ts).
			// Published at distinct instants: listPosts orders by created_at, which
			// ties within a test, so published_at is what makes the order defined.
			const alert = (name: string, hour: string, title: string): void => {
				slugs.push(
					publish(db, `${name}-alert-abcd1234`, `2026-09-03T${hour}:00.000Z`, {
						postType: "alert",
						title: `Weather Alert: ${title}`,
					}),
				);
			};
			alert(
				"heat",
				"14:00",
				"Heat Advisory issued September 2 at 2:30AM PDT until " +
					"September 3 at 8:00PM PDT by NWS San Diego CA",
			);
			alert(
				"wind",
				"15:00",
				"High Wind Advisory issued September 2 by NWS San Diego CA",
			);
			// A red flag warning is a forecast of fire RISK, so it goes too: if
			// anything actually burned, the sheriff's release below is the story.
			alert(
				"redflag",
				"16:00",
				"Red Flag Warning issued September 2 by NWS San Diego CA",
			);
			// Flooding leaves damage behind, so it still has something to say.
			alert(
				"flood",
				"17:00",
				"Flood Warning issued September 2 by NWS San Diego CA",
			);

			// Nixle sheriff releases are alert-typed too, and end `-nixle-<hash>`.
			// This one mentions wind and rain and must survive anyway.
			slugs.push(
				publish(db, "release-nixle-99887766", "2026-09-03T18:00:00.000Z", {
					postType: "alert",
					title: "High Wind Downs Power Line, Rain Closes Los Serranos Roads",
				}),
			);

			assert.deepEqual(
				podcastInputs(db, MONDAY).posts.map((p) => p.title),
				[
					"Weather Alert: Flood Warning issued September 2 by NWS San Diego CA",
					"High Wind Downs Power Line, Rain Closes Los Serranos Roads",
				],
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
				slug: `${SLUG_PREFIX}-2026-W36-recap`,
				postType: "meeting_recap",
				tier: "A",
				title: "Recap",
				bodyMd: "Body.",
				sources: [SOURCE],
			});
			const lower = `${SLUG_PREFIX}-2026-w36-recap`;
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

	test("drops a standing program and folds a meeting two calendars both list", () => {
		const db = openDb(":memory:");
		// Four consecutive Tuesdays, the last inside the episode's week: by the
		// third the calendar is describing its own wallpaper, not the week.
		for (const day of ["08-18", "08-25", "09-01", "09-08"]) {
			addEvent(
				db,
				"sbclib-events",
				`story-${day}`,
				`2026-${day}T20:00:00.000Z`,
				"Preschool Storytime",
			);
		}
		// One meeting, two calendars, two external_ids — so selectUpcomingEvents'
		// dedupe by identity lets both through and only the title/day key folds them.
		addEvent(
			db,
			"sbclib-events",
			"council-lib",
			"2026-09-09T20:00:00.000Z",
			"City Council - Regular Meeting",
		);
		addEvent(
			db,
			"cvusd-calendar",
			"council-district",
			"2026-09-09T20:00:00.000Z",
			"city council - regular meeting",
		);

		assert.deepEqual(
			podcastInputs(db, MONDAY).events.map((e) => e.title.toLowerCase()),
			["city council - regular meeting"],
		);
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

// The podcast timer fires Mondays only. If the resume lookup were keyed off
// the current week's slug, an episode approved on a Tuesday would be found by
// no later run — the next Monday computes a new week and regenerates over it.
describe("pendingAudioEpisode", () => {
	const PREFIX = `${SLUG_PREFIX}-pending`;

	function heldEpisode(
		db: ReturnType<typeof openDb>,
		name: string,
		heldReason: string,
		over: Partial<NewPost> = {},
	): string {
		const slug = `${PREFIX}-${name}`;
		createPost(db, {
			slug,
			postType: "podcast",
			tier: "B",
			title: `Episode ${name}`,
			bodyMd: `Body for ${name}.`,
			sources: [SOURCE],
			meetingDate: "2026-09-07",
			...over,
		});
		transitionPost(db, slug, "held", { heldReason });
		return slug;
	}

	test("finds an episode approved in the dashboard, with its week", () => {
		const db = openDb(":memory:");
		const slug = heldEpisode(
			db,
			"approved",
			"audio:approved — renders next run",
		);
		try {
			const found = pendingAudioEpisode(db);
			assert.equal(found?.slug, slug);
			// The week comes off the row, not off today's date: this is what lets
			// a run on any weekday pick the episode back up.
			assert.equal(found?.meeting_date, "2026-09-07");
		} finally {
			cleanup([slug]);
		}
	});

	test("finds an episode whose render failed", () => {
		const db = openDb(":memory:");
		const slug = heldEpisode(db, "failed", "audio: TTS chunk 3 rejected");
		try {
			assert.equal(pendingAudioEpisode(db)?.slug, slug);
		} finally {
			cleanup([slug]);
		}
	});

	test("ignores holds that are not waiting on audio", () => {
		const db = openDb(":memory:");
		const slugs = [
			heldEpisode(db, "gate2", "gate2: judge flagged tone"),
			heldEpisode(db, "tierc", "tierC: names a private individual"),
		];
		try {
			assert.equal(pendingAudioEpisode(db), undefined);
		} finally {
			cleanup(slugs);
		}
	});

	test("ignores a non-podcast hold", () => {
		const db = openDb(":memory:");
		const slug = heldEpisode(db, "recap", "audio:approved", {
			postType: "meeting_recap",
		});
		try {
			assert.equal(pendingAudioEpisode(db), undefined);
		} finally {
			cleanup([slug]);
		}
	});

	test("returns the oldest when a week's backlog has piled up", () => {
		const db = openDb(":memory:");
		const older = heldEpisode(db, "older", "audio:approved", {
			meetingDate: "2026-08-31",
		});
		db.raw
			.prepare("UPDATE posts SET created_at = ? WHERE slug = ?")
			.run("2026-08-31T10:00:00.000Z", older);
		const newer = heldEpisode(db, "newer", "audio:approved");
		db.raw
			.prepare("UPDATE posts SET created_at = ? WHERE slug = ?")
			.run("2026-09-07T10:00:00.000Z", newer);
		try {
			assert.equal(pendingAudioEpisode(db)?.slug, older);
		} finally {
			cleanup([older, newer]);
		}
	});
});

describe("week-ahead curation", () => {
	test("standingProgramTitles: a weekly program is standing, a one-off is not", () => {
		const items = [
			// Same title across four distinct weeks.
			{ title: "Preschool Storytime", occurred_at: "2026-08-04T17:00:00Z" },
			{ title: "Preschool Storytime", occurred_at: "2026-08-11T17:00:00Z" },
			{ title: "Preschool Storytime", occurred_at: "2026-08-18T17:00:00Z" },
			{
				title: "  preschool   storytime ",
				occurred_at: "2026-08-25T17:00:00Z",
			},
			// Twice in ONE week is not a series.
			{ title: "Milkcan Blood Drive", occurred_at: "2026-09-15T17:00:00Z" },
			{ title: "Milkcan Blood Drive", occurred_at: "2026-09-16T17:00:00Z" },
			{ title: "Annual Milkcan Game", occurred_at: "2026-09-20T17:00:00Z" },
			{ title: null, occurred_at: "2026-09-20T17:00:00Z" },
			{ title: "No date", occurred_at: null },
		];
		const standing = standingProgramTitles(items, "2026-08-24");
		assert.ok(standing.has("preschool storytime"));
		assert.ok(!standing.has("milkcan blood drive"));
		assert.ok(!standing.has("annual milkcan game"));
	});

	test("standingProgramTitles: a gap breaks the run, so meetings survive history", () => {
		// The calendar keeps growing, so anything counted over all of it becomes
		// standing eventually. These are the cases that must never be dropped no
		// matter how many years accumulate.
		const monthly = ["2026-01-13", "2026-02-10", "2026-03-10", "2026-04-14"];
		const twiceMonthly = [
			// First and third Tuesday: three distinct weeks inside one month, but
			// never two in a row.
			"2026-01-06",
			"2026-01-20",
			"2026-02-03",
			"2026-02-17",
			"2026-03-03",
		];
		const annual = ["2024-09-20", "2025-09-19", "2026-09-18"];
		const standing = standingProgramTitles(
			[
				...monthly.map((d) => ({
					title: "Planning Commission Meeting",
					occurred_at: `${d}T02:00:00Z`,
				})),
				...twiceMonthly.map((d) => ({
					title: "City Council - Regular Meeting",
					occurred_at: `${d}T02:00:00Z`,
				})),
				...annual.map((d) => ({
					title: "Annual Milkcan Game",
					occurred_at: `${d}T02:00:00Z`,
				})),
				// A weekly program that skips a week and comes back still runs long
				// enough on one side of the gap to be wallpaper.
				...[
					"2026-08-04",
					"2026-08-11",
					"2026-08-25",
					"2026-09-01",
					"2026-09-08",
				].map((d) => ({
					title: "Craft Corner",
					occurred_at: `${d}T17:00:00Z`,
				})),
			],
			"2026-09-07",
		);

		assert.ok(!standing.has("planning commission meeting"));
		assert.ok(!standing.has("city council - regular meeting"));
		assert.ok(!standing.has("annual milkcan game"));
		assert.ok(standing.has("craft corner"));
	});

	test("standingProgramTitles: a finished series stops being standing", () => {
		// Three consecutive August weeks and then nothing until an isolated
		// September revival. The August run is over by the time the September
		// episode runs, so the one-off occurrence is the episode's to name.
		const items = [
			...["2026-08-04", "2026-08-11", "2026-08-18", "2026-09-15"].map((d) => ({
				title: "Craft Corner",
				occurred_at: `${d}T17:00:00Z`,
			})),
			// Control: still running through the episode's own week.
			...["2026-08-25", "2026-09-01", "2026-09-08", "2026-09-15"].map((d) => ({
				title: "Preschool Storytime",
				occurred_at: `${d}T17:00:00Z`,
			})),
		];
		const standing = standingProgramTitles(items, "2026-09-14");
		assert.ok(!standing.has("craft corner"));
		assert.ok(standing.has("preschool storytime"));
	});

	test("standingProgramTitles: a series that has not started yet is not standing", () => {
		// The calendar query has no upper bound, so a November series is visible
		// in September. It must not suppress the isolated September occurrence —
		// and a run that STARTS in the episode's week still must.
		const items = [
			...["2026-09-15", "2026-11-03", "2026-11-10", "2026-11-17"].map((d) => ({
				title: "Craft Corner",
				occurred_at: `${d}T17:00:00Z`,
			})),
			...["2026-09-15", "2026-09-22", "2026-09-29"].map((d) => ({
				title: "Preschool Storytime",
				occurred_at: `${d}T17:00:00Z`,
			})),
		];
		const standing = standingProgramTitles(items, "2026-09-14");
		assert.ok(!standing.has("craft corner"));
		assert.ok(standing.has("preschool storytime"));
	});

	test("standingProgramTitles: a series starting in the episode week qualifies on every weekday", () => {
		// Week buckets have to be the episode's own Monday–Sunday week. Aligned
		// anywhere else, a series whose first occurrence is late in the week falls
		// in the next bucket and escapes the filter in its opening episode.
		const items = [];
		for (let offset = 0; offset < 7; offset++) {
			for (const week of [0, 7, 14]) {
				// 2026-09-14 is the anchor Monday; 17:00Z is 10am Pacific same day.
				const day = Date.UTC(2026, 8, 14 + offset + week, 17);
				items.push({
					title: `Series Day ${offset}`,
					occurred_at: new Date(day).toISOString(),
				});
			}
		}
		const standing = standingProgramTitles(items, "2026-09-14");
		for (let offset = 0; offset < 7; offset++) {
			assert.ok(
				standing.has(`series day ${offset}`),
				`weekday offset ${offset} should be standing`,
			);
		}
	});

	test("standingProgramTitles: an unusable anchor names itself", () => {
		// The anchor goes straight to weekIndexOf, which returns null for anything
		// it cannot read, so the guard reports the bad value instead of the bare
		// "Invalid time value" a Date round-trip would throw.
		assert.throws(
			() => standingProgramTitles([], "not-a-date"),
			/unusable anchor: not-a-date/,
		);
	});

	test("dedupeEvents: one listing per title per day, later days kept", () => {
		const events = [
			{ title: "City Council - Regular Meeting", date: "2026-09-15" },
			{ title: "city council - regular meeting", date: "2026-09-15" },
			{ title: "City Council - Regular Meeting", date: "2026-09-22" },
			{ title: "Planning Commission Meeting", date: "2026-09-15" },
		];
		// Lowercased in the assertion because which of two listings of the same
		// meeting survives is arbitrary; that one row per title per day survives,
		// in calendar order, is the contract.
		assert.deepEqual(
			dedupeEvents(events).map((e) => `${e.date} ${e.title.toLowerCase()}`),
			[
				"2026-09-15 city council - regular meeting",
				"2026-09-22 city council - regular meeting",
				"2026-09-15 planning commission meeting",
			],
		);
	});
});
