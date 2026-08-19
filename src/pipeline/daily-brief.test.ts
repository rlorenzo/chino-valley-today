import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import type { ItemRow } from "../tiera/queries.ts";
import {
	assembleBrief,
	assertPrerequisitesFresh,
	type BriefInputs,
	checkHeadlinesFreshness,
	DAILY_BRIEF_PREREQUISITE_SOURCES,
	decodeEntities,
	HEADLINES_SOURCES,
	isLaWednesday,
	jaccardSimilarity,
	laTimeOf,
	postTitleFromFile,
	selectActiveAlerts,
	selectFireSafety,
	selectFreshLicenseEvents,
	selectHeadlinesElsewhere,
	selectNewRecordPosts,
	selectTodayEvents,
	selectTodayMeetings,
	selectUpcomingEvents,
	selectWeather,
	titleTokens,
} from "./daily-brief.ts";
import { type PostRow, renderPostFile } from "./posts.ts";

// 6:05 AM PDT, Monday 2026-08-17 — the timer's real run window.
const NOW = new Date("2026-08-17T13:05:00.000Z");
// 6:05 AM PDT, Wednesday 2026-08-19.
const WEDNESDAY = new Date("2026-08-19T13:05:00.000Z");

let seq = 0;
function item(over: Partial<ItemRow>): ItemRow {
	seq++;
	return {
		id: seq,
		document_id: 1,
		source_url: `https://example.org/item-${seq}`,
		item_type: "event",
		external_id: null,
		title: "Untitled",
		body: null,
		meta: null,
		occurred_at: null,
		source_key: "test",
		doc_url: "https://example.org/doc",
		doc_type: "agenda",
		doc_title: null,
		doc_meeting_date: null,
		doc_location: null,
		doc_event_key: null,
		...over,
	};
}

function forecastItem(over: {
	city: string;
	periodName: string;
	isDaytime: boolean;
	occurred_at: string;
	body: string;
	external_id?: string;
	source_url?: string;
}): ItemRow {
	return item({
		item_type: "forecast_period",
		source_key: "nws-forecast",
		source_url: over.source_url ?? `https://forecast.weather.gov/${over.city}`,
		external_id: over.external_id ?? `grid:${over.occurred_at}:${over.city}`,
		title: `${over.city} — ${over.periodName}`,
		body: over.body,
		occurred_at: over.occurred_at,
		meta: JSON.stringify({
			city: over.city,
			periodName: over.periodName,
			isDaytime: over.isDaytime,
		}),
	});
}

function post(over: Partial<PostRow>): PostRow {
	seq++;
	return {
		id: seq,
		slug: `2026-08-16-post-${seq}`,
		post_type: "meeting_preview",
		tier: "A",
		status: "published",
		file_path: "content/published/x.md",
		meeting_date: null,
		gates: null,
		judge: null,
		source_count: 1,
		held_reason: null,
		published_via: "auto",
		created_at: "2026-08-16T00:00:00.000Z",
		published_at: "2026-08-16T12:00:00.000Z",
		...over,
	};
}

function emptyInputs(): BriefInputs {
	return {
		forecast: [],
		nwsAlerts: [],
		fire: [],
		calendarEvents: [],
		agendaItems: [],
		cvusdEvents: [],
		licenseEvents: [],
		publishedPosts: [],
		prevBriefPublishedAt: null,
	};
}

describe("laTimeOf", () => {
	test("formats a real instant in Pacific time", () => {
		assert.equal(laTimeOf("2026-08-18T01:00:00.000Z"), "6:00 PM");
	});
	test("date-only values and midnight-Pacific date-carriers yield no time", () => {
		assert.equal(laTimeOf("2026-08-17"), null);
		assert.equal(laTimeOf("2026-07-28T07:00:00.000Z"), null); // midnight PDT
		assert.equal(laTimeOf(null), null);
	});
});

describe("decodeEntities", () => {
	test("decodes ordinary entities in one pass", () => {
		assert.equal(decodeEntities("A &#038; B"), "A & B");
		assert.equal(decodeEntities("A &amp; B"), "A & B");
		assert.equal(decodeEntities("caf&#233;"), "café");
	});
	test("never double-unescapes and never materializes markup", () => {
		// Doubly-encoded ampersand: one level only, output is literal text.
		assert.equal(decodeEntities("&#38;amp;"), "&amp;");
		// "<" and ">" stay encoded — this string lands in markdown, where raw
		// HTML passes through.
		assert.equal(
			decodeEntities("&#60;script&#62;alert(1)&#60;/script&#62;"),
			"&#60;script&#62;alert(1)&#60;/script&#62;",
		);
		// Out-of-range / control-char code points are left alone, not thrown on.
		assert.equal(decodeEntities("&#1114112;"), "&#1114112;");
		assert.equal(decodeEntities("&#8;"), "&#8;");
	});
});

describe("selectWeather", () => {
	test("picks today's daytime and tonight's period per city, sorted by city", () => {
		const rows = [
			forecastItem({
				city: "Chino Hills",
				periodName: "Today",
				isDaytime: true,
				occurred_at: "2026-08-17T13:00:00.000Z",
				body: "Sunny, high near 89.",
			}),
			forecastItem({
				city: "Chino",
				periodName: "Today",
				isDaytime: true,
				occurred_at: "2026-08-17T13:00:00.000Z",
				body: "Sunny, high near 94.",
			}),
			forecastItem({
				city: "Chino",
				periodName: "Tonight",
				isDaytime: false,
				occurred_at: "2026-08-18T01:00:00.000Z",
				body: "Mostly clear, low around 68.",
			}),
			// Tomorrow's period must not leak into today's line.
			forecastItem({
				city: "Chino",
				periodName: "Tuesday",
				isDaytime: true,
				occurred_at: "2026-08-18T13:00:00.000Z",
				body: "Hot.",
			}),
		];
		const out = selectWeather(rows, NOW);
		assert.deepEqual(
			out.map((c) => c.city),
			["Chino", "Chino Hills"],
		);
		assert.deepEqual(
			out[0].periods.map((p) => p.name),
			["Today", "Tonight"],
		);
		assert.deepEqual(
			out[1].periods.map((p) => p.name),
			["Today"],
		);
	});

	test("a later-starting daytime period supersedes the morning one", () => {
		const rows = [
			forecastItem({
				city: "Chino",
				periodName: "Today",
				isDaytime: true,
				occurred_at: "2026-08-17T13:00:00.000Z",
				body: "Morning words.",
			}),
			forecastItem({
				city: "Chino",
				periodName: "This Afternoon",
				isDaytime: true,
				occurred_at: "2026-08-17T20:00:00.000Z",
				body: "Afternoon words.",
			}),
		];
		const out = selectWeather(rows, NOW);
		assert.deepEqual(
			out[0].periods.map((p) => p.name),
			["This Afternoon"],
		);
	});

	test("re-scraped periods dedupe by external_id, keeping the freshest row", () => {
		const shared = { external_id: "SGX/47,73:2026-08-17T13:00:00.000Z" };
		const rows = [
			forecastItem({
				city: "Chino",
				periodName: "Today",
				isDaytime: true,
				occurred_at: "2026-08-17T13:00:00.000Z",
				body: "Stale forecast.",
				...shared,
			}),
			forecastItem({
				city: "Chino",
				periodName: "Today",
				isDaytime: true,
				occurred_at: "2026-08-17T13:00:00.000Z",
				body: "Fresh forecast.",
				...shared,
			}),
		];
		const out = selectWeather(rows, NOW);
		assert.equal(out.length, 1);
		assert.equal(out[0].periods[0].body, "Fresh forecast.");
	});
});

describe("selectActiveAlerts", () => {
	const alert = (ends: string | null) =>
		item({
			item_type: "alert",
			source_key: "nws-alerts",
			title: "Heat Advisory",
			meta: ends === null ? "{}" : JSON.stringify({ ends }),
		});
	test("active means meta.ends strictly after now; no end time is not active", () => {
		const out = selectActiveAlerts(
			[
				alert("2026-08-17T20:00:00-07:00"),
				alert("2026-08-16T20:00:00-07:00"),
				alert(null),
			],
			NOW,
		);
		assert.equal(out.length, 1);
	});
});

describe("selectFireSafety", () => {
	test("24h window, chinoRelevant filter for the county feed, dedupe by source_url", () => {
		const rows = [
			item({
				item_type: "news_release",
				source_key: "sbcfire-news",
				title: "Structure fire in Chino",
				source_url: "https://sbcfire.org/a",
				occurred_at: "2026-08-17T02:00:00.000Z",
				meta: JSON.stringify({ chinoRelevant: true }),
			}),
			// Same permalink re-ingested: must collapse to one line.
			item({
				item_type: "news_release",
				source_key: "sbcfire-news",
				title: "Structure fire in Chino",
				source_url: "https://sbcfire.org/a",
				occurred_at: "2026-08-17T02:00:00.000Z",
				meta: JSON.stringify({ chinoRelevant: true }),
			}),
			// County-wide item not mentioning Chino: excluded by assembler decision.
			item({
				item_type: "news_release",
				source_key: "sbcfire-news",
				title: "Fire in Needles",
				source_url: "https://sbcfire.org/b",
				occurred_at: "2026-08-17T02:00:00.000Z",
				meta: JSON.stringify({ chinoRelevant: false }),
			}),
			// Local district: included with no relevance flag required.
			item({
				item_type: "alert",
				source_key: "cvfd-news",
				title: "CVFD alert",
				source_url: "https://chinovalleyfire.org/alert",
				occurred_at: "2026-08-17T01:00:00.000Z",
			}),
			// Older than 24h: out of window.
			item({
				item_type: "news_release",
				source_key: "cvfd-news",
				title: "Old news",
				source_url: "https://chinovalleyfire.org/old",
				occurred_at: "2026-08-15T01:00:00.000Z",
			}),
		];
		const out = selectFireSafety(rows, NOW);
		assert.deepEqual(out.map((r) => r.source_url).sort(), [
			"https://chinovalleyfire.org/alert",
			"https://sbcfire.org/a",
		]);
	});
});

describe("selectTodayEvents", () => {
	test("today means the LA calendar day, not the UTC day", () => {
		const rows = [
			// 6 PM PDT Aug 17 = Aug 18 in UTC: still today.
			item({
				source_key: "sbclib-events",
				title: "Evening storytime",
				occurred_at: "2026-08-18T01:00:00.000Z",
			}),
			// 10 PM PDT Aug 16 = Aug 17 in UTC: yesterday, excluded.
			item({
				source_key: "sbclib-events",
				title: "Last night",
				occurred_at: "2026-08-17T05:00:00.000Z",
			}),
			// Tomorrow, excluded.
			item({
				source_key: "sbclib-events",
				title: "Tomorrow",
				occurred_at: "2026-08-18T18:00:00.000Z",
			}),
		];
		const out = selectTodayEvents(rows, NOW);
		assert.deepEqual(
			out.map((e) => e.title),
			["Evening storytime"],
		);
	});

	test("CBWCD District Holiday closures are filtered; recurrences dedupe by source_url", () => {
		const rows = [
			item({
				source_key: "cbwcd-events",
				title: "District Holiday: Christmas Eve",
				occurred_at: "2026-08-17T18:00:00.000Z",
			}),
			item({
				source_key: "cbwcd-events",
				title: "Garden class",
				source_url: "https://cbwcd.org/event/garden",
				occurred_at: "2026-08-17T18:00:00.000Z",
			}),
			item({
				source_key: "cbwcd-events",
				title: "Garden class",
				source_url: "https://cbwcd.org/event/garden",
				occurred_at: "2026-08-17T18:00:00.000Z",
			}),
		];
		const out = selectTodayEvents(rows, NOW);
		assert.equal(out.length, 1);
		assert.equal(out[0].title, "Garden class");
	});

	test("CivicPlus times normalize and venues decode entities", () => {
		const rows = [
			item({
				source_key: "chino-news-rss",
				title: "Planning Commission Meeting",
				occurred_at: "2026-08-18T01:00:00.000Z",
				meta: JSON.stringify({
					eventTimes: "06:00 PM - 11:59 PM",
					location: "13220 Central AvenueChino, CA 91710",
				}),
			}),
			item({
				source_key: "cbwcd-events",
				title: "Compost giveaway",
				occurred_at: "2026-08-17T15:00:00.000Z",
				meta: JSON.stringify({
					venue: "Waterwise Community Center &#038; District",
					allDay: false,
				}),
			}),
		];
		const out = selectTodayEvents(rows, NOW);
		const civic = out.find((e) => e.title === "Planning Commission Meeting");
		assert.equal(civic?.timeLabel, "06:00 PM");
		assert.equal(civic?.venue, "13220 Central Avenue, Chino, CA 91710");
		const cbwcd = out.find((e) => e.title === "Compost giveaway");
		assert.equal(cbwcd?.venue, "Waterwise Community Center & District");
		assert.equal(cbwcd?.timeLabel, "8:00 AM");
	});
});

describe("selectUpcomingEvents", () => {
	test("the default horizon is 30 LA days, exclusive of today", () => {
		const rows = [
			item({
				source_key: "sbclib-events",
				title: "Day 8",
				occurred_at: "2026-08-25T18:00:00.000Z",
			}),
			// Day 30 exactly: included.
			item({
				source_key: "cbwcd-events",
				title: "Day 30",
				occurred_at: "2026-09-16T16:00:00.000Z",
			}),
			// Day 31: out of the horizon.
			item({
				source_key: "cbwcd-events",
				title: "Day 31",
				occurred_at: "2026-09-17T16:00:00.000Z",
			}),
		];
		assert.deepEqual(
			selectUpcomingEvents(rows, NOW).map((e) => e.title),
			["Day 8", "Day 30"],
		);
	});

	test("the window is (today, today+horizon] in LA days; closures stay filtered", () => {
		const rows = [
			// Today: excluded — it lives in the brief body.
			item({
				source_key: "sbclib-events",
				title: "Today's storytime",
				occurred_at: "2026-08-17T18:00:00.000Z",
			}),
			// Tomorrow evening (UTC already Aug 19): included, dated Aug 18.
			item({
				source_key: "sbclib-events",
				title: "Tomorrow's craft corner",
				occurred_at: "2026-08-19T01:00:00.000Z",
			}),
			// Day 7 exactly: included.
			item({
				source_key: "cbwcd-events",
				title: "Garden class",
				occurred_at: "2026-08-24T16:00:00.000Z",
			}),
			// Day 8: out of the horizon.
			item({
				source_key: "cbwcd-events",
				title: "Too far out",
				occurred_at: "2026-08-25T16:00:00.000Z",
			}),
			// Closure notice inside the window: still filtered.
			item({
				source_key: "cbwcd-events",
				title: "District Holiday: Christmas Eve",
				occurred_at: "2026-08-20T16:00:00.000Z",
			}),
		];
		const out = selectUpcomingEvents(rows, NOW, 7);
		assert.deepEqual(
			out.map((e) => [e.date, e.title]),
			[
				["2026-08-18", "Tomorrow's craft corner"],
				["2026-08-24", "Garden class"],
			],
		);
	});
});

describe("selectTodayMeetings", () => {
	test("agenda items group to one line per document; cvusd date-only events carry no time", () => {
		const agenda = [
			item({
				item_type: "agenda_item",
				source_key: "chinohills-agendas",
				title: "Item 1",
				doc_url: "https://chinohills.org/agenda/123",
				doc_title: "City Council Regular Meeting",
				doc_meeting_date: "2026-08-17",
			}),
			item({
				item_type: "agenda_item",
				source_key: "chinohills-agendas",
				title: "Item 2",
				doc_url: "https://chinohills.org/agenda/123",
				doc_title: "City Council Regular Meeting",
				doc_meeting_date: "2026-08-17",
			}),
			item({
				item_type: "agenda_item",
				source_key: "chino-legistar",
				title: "Other day",
				doc_url: "https://chino.legistar.com/agenda/9",
				doc_meeting_date: "2026-08-19",
			}),
		];
		const cvusd = [
			item({
				item_type: "event",
				source_key: "cvusd-board",
				title: "Board of Education Regular Meeting — 2026-08-17",
				source_url: "https://example.org/cvusd-agenda.pdf",
				occurred_at: "2026-08-17",
			}),
		];
		const out = selectTodayMeetings(agenda, cvusd, NOW);
		assert.equal(out.length, 2);
		const council = out.find((m) => m.title === "City Council Regular Meeting");
		assert.ok(council);
		const board = out.find((m) => m.title.startsWith("Board of Education"));
		assert.equal(board?.timeLabel, null);
	});
});

describe("new on the record", () => {
	test("posts published after the previous brief, excluding briefs themselves", () => {
		const posts = [
			post({
				slug: "2026-08-16-old-recap",
				published_at: "2026-08-16T05:00:00.000Z",
			}),
			post({
				slug: "2026-08-16-fresh-preview",
				published_at: "2026-08-16T18:00:00.000Z",
			}),
			post({
				slug: "2026-08-16-daily-brief",
				post_type: "daily-brief",
				published_at: "2026-08-16T18:30:00.000Z",
			}),
			post({
				slug: "2026-08-16-still-queued",
				status: "queued",
				published_at: null,
			}),
		];
		const out = selectNewRecordPosts(posts, "2026-08-16T13:00:00.000Z");
		assert.deepEqual(
			out.map((p) => p.slug),
			["2026-08-16-fresh-preview"],
		);
	});

	test("license events dedupe by external_id, not their shared report URL", () => {
		const url =
			"https://www.abc.ca.gov/licensing/licensing-reports/status-changes/";
		const rows = [
			item({
				item_type: "license_event",
				source_key: "abc-licenses",
				title: "A — Type 20 ACTIVE→REVPEN",
				source_url: url,
				external_id: "399692",
				occurred_at: "2026-08-17",
			}),
			item({
				item_type: "license_event",
				source_key: "abc-licenses",
				title: "B — Type 41 ACTIVE→REVPEN",
				source_url: url,
				external_id: "647201",
				occurred_at: "2026-08-17",
			}),
			item({
				item_type: "license_event",
				source_key: "abc-licenses",
				title: "Old",
				source_url: url,
				external_id: "111111",
				occurred_at: "2026-08-10",
			}),
		];
		const out = selectFreshLicenseEvents(rows, NOW);
		assert.equal(out.length, 2);
	});
});

describe("postTitleFromFile", () => {
	test("reads the frontmatter title, falling back to slug words", () => {
		// A committed fixture, not a real published post — corrections
		// legitimately edit those, and this test must not break on one. The
		// fixture body carries a decoy `title:` line, pinning that a body line
		// can never shadow the frontmatter title (first match wins).
		const fixture = post({
			slug: "2026-08-17-fixture-post",
			file_path: "src/pipeline/__fixtures__/frontmatter-title.md",
		});
		assert.equal(
			postTitleFromFile(fixture),
			"Fixture Post — Title Reader Check",
		);
		const gone = post({
			slug: "2026-08-16-vanished-preview",
			file_path: "content/published/does-not-exist.md",
		});
		assert.equal(postTitleFromFile(gone), "vanished preview");
	});
});

describe("assembleBrief", () => {
	function quietInputs(): BriefInputs {
		return {
			...emptyInputs(),
			forecast: [
				forecastItem({
					city: "Chino",
					periodName: "Today",
					isDaytime: true,
					occurred_at: "2026-08-17T13:00:00.000Z",
					body: "Sunny, high near 94.",
					source_url: "https://forecast.weather.gov/chino",
				}),
				forecastItem({
					city: "Chino Hills",
					periodName: "Today",
					isDaytime: true,
					occurred_at: "2026-08-17T13:00:00.000Z",
					body: "Sunny, high near 89.",
					source_url: "https://forecast.weather.gov/chino-hills",
				}),
			],
		};
	}

	test("a quiet day is weather-only, labeled plainly, with non-empty sources", () => {
		const { post: p } = assembleBrief(quietInputs(), NOW);
		assert.equal(p.slug, "2026-08-17-daily-brief");
		assert.equal(p.postType, "daily-brief");
		assert.equal(p.tier, "A");
		assert.equal(p.briefDate, "2026-08-17");
		assert.deepEqual(p.sources, [
			"https://forecast.weather.gov/chino",
			"https://forecast.weather.gov/chino-hills",
		]);
		// The quiet label states what the morning is; it does not roll-call
		// alarming things that didn't happen.
		assert.match(
			p.bodyMd,
			/A quiet morning — nothing new beyond the forecast\./,
		);
		assert.doesNotMatch(p.bodyMd, /fire/i);
		assert.doesNotMatch(p.bodyMd, /## Fire & safety/);
		assert.doesNotMatch(p.bodyMd, /## Today/);
		assert.doesNotMatch(p.bodyMd, /## New on the record/);
		assert.doesNotMatch(p.bodyMd, /minutes/i);
	});

	test("populated sections render with per-item citations and a deduped source union", () => {
		const inputs = quietInputs();
		inputs.fire = [
			item({
				item_type: "news_release",
				source_key: "sbcfire-news",
				title: "Vegetation fire near Chino Hills",
				source_url: "https://sbcfire.org/veg-fire",
				occurred_at: "2026-08-17T04:00:00.000Z",
				meta: JSON.stringify({ chinoRelevant: true, bodyIsFullText: true }),
				body: "PRIVATE NAME MUST NOT RENDER",
			}),
		];
		inputs.calendarEvents = [
			item({
				source_key: "sbclib-events",
				title: "Preschool Storytime",
				source_url: "https://library.sbcounty.gov/event/storytime",
				occurred_at: "2026-08-17T18:00:00.000Z",
				meta: JSON.stringify({ venue: "Chino Branch Library" }),
			}),
		];
		inputs.publishedPosts = [
			post({
				slug: "2026-08-17-chino-city-council-preview",
				published_at: "2026-08-17T01:00:00.000Z",
			}),
		];
		inputs.prevBriefPublishedAt = "2026-08-16T13:10:00.000Z";
		const { post: p } = assembleBrief(inputs, NOW);
		assert.match(p.bodyMd, /## Fire & safety/);
		assert.match(
			p.bodyMd,
			/\[Vegetation fire near Chino Hills\]\(https:\/\/sbcfire\.org\/veg-fire\)/,
		);
		// Fire bodies never render — title + link only.
		assert.doesNotMatch(p.bodyMd, /PRIVATE NAME MUST NOT RENDER/);
		assert.match(p.bodyMd, /11:00 AM — \[Preschool Storytime\]/);
		assert.match(
			p.bodyMd,
			/\[chino city council preview\]\(\/posts\/2026-08-17-chino-city-council-preview\/\)/,
		);
		assert.doesNotMatch(p.bodyMd, /A quiet morning/);
		assert.ok(new Set(p.sources).has("https://sbcfire.org/veg-fire"));
		assert.equal(new Set(p.sources).size, p.sources.length);
	});

	test("week-ahead events ship as frontmatter, not body, and join sources", () => {
		const inputs = quietInputs();
		inputs.calendarEvents = [
			item({
				source_key: "sbclib-events",
				title: "Tomorrow's craft corner",
				source_url: "https://library.sbcounty.gov/event/craft-tomorrow",
				occurred_at: "2026-08-18T18:00:00.000Z",
				meta: JSON.stringify({ venue: "Chino Branch Library" }),
			}),
		];
		const { post: p } = assembleBrief(inputs, NOW);
		assert.deepEqual(p.eventsAhead, [
			{
				date: "2026-08-18",
				time: "11:00 AM",
				title: "Tomorrow's craft corner",
				venue: "Chino Branch Library",
				url: "https://library.sbcounty.gov/event/craft-tomorrow",
			},
		]);
		// The rail is layout; the body stays today's brief.
		assert.doesNotMatch(p.bodyMd, /craft corner/i);
		assert.ok(
			new Set(p.sources).has(
				"https://library.sbcounty.gov/event/craft-tomorrow",
			),
		);
		// And the frontmatter serializes as a structured list the site schema
		// can validate.
		const file = renderPostFile(p, "2026-08-17T13:05:00.000Z");
		assert.match(file, /events_ahead:\n {2}- date: "2026-08-18"/);
		assert.match(file, /"Tomorrow's craft corner"/);
	});

	test("the farmers market line renders on Wednesdays only, with its source", () => {
		const monday = assembleBrief(quietInputs(), NOW);
		assert.doesNotMatch(monday.post.bodyMd, /Heritage Farmers Market/);
		const wednesday = assembleBrief(quietInputs(), WEDNESDAY);
		assert.equal(wednesday.post.slug, "2026-08-19-daily-brief");
		assert.match(
			wednesday.post.bodyMd,
			/A quiet morning — nothing new beyond the forecast and today's schedule\./,
		);
		assert.match(wednesday.post.bodyMd, /Heritage Farmers Market/);
		assert.ok(
			new Set(wednesday.post.sources).has(
				"https://heritagefarmersmarket.org/chino-hills",
			),
		);
		assert.ok(isLaWednesday(WEDNESDAY));
		assert.ok(!isLaWednesday(NOW));
	});
});

describe("DAILY_BRIEF_PREREQUISITE_SOURCES", () => {
	test("contains exactly the 15 canonical prerequisite source keys", () => {
		assert.equal(DAILY_BRIEF_PREREQUISITE_SOURCES.length, 15);
		assert.deepEqual(
			[...DAILY_BRIEF_PREREQUISITE_SOURCES],
			[
				"nws-forecast",
				"nws-alerts",
				"sbcfire-news",
				"cvfd-news",
				"chino-news-rss",
				"chinohills-news-rss",
				"chino-legistar",
				"chino-agendacenter",
				"chinohills-agendas",
				"cvusd-board",
				"sbclib-events",
				"sbparks-events",
				"cbwcd-events",
				"yanksair-events",
				"abc-licenses",
			],
		);
	});
});

describe("assertPrerequisitesFresh", () => {
	function populateSource(
		db: ReturnType<typeof openDb>,
		sourceKey: string,
		opts: {
			runStatus?: "success" | "failure" | "running";
			runFinishedAt?: string;
			docFetchedAt?: string | null;
			errorMessage?: string;
		} = {},
	) {
		const sourceId = db.upsertSource({
			key: sourceKey,
			name: sourceKey,
			base_url: `https://example.org/${sourceKey}`,
			method: "html",
		});

		const status = opts.runStatus ?? "success";
		const finishedAt =
			status === "running"
				? null
				: (opts.runFinishedAt ?? "2026-08-17T12:55:00.000Z");

		db.raw
			.prepare(
				`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, error_message, documents_count, items_count)
         VALUES (?, '2026-08-17T12:50:00.000Z', ?, ?, ?, 1, 1)`,
			)
			.run(sourceKey, finishedAt, status, opts.errorMessage ?? null);

		if (opts.docFetchedAt !== null) {
			const fetchedAt = opts.docFetchedAt ?? "2026-08-17T12:52:00.000Z";
			db.raw
				.prepare(
					`INSERT INTO documents (source_id, url, doc_type, fetched_at, content_hash, raw_path)
           VALUES (?, ?, 'agenda', ?, 'hash', '/raw/path')`,
				)
				.run(sourceId, `https://example.org/${sourceKey}/doc`, fetchedAt);
		}
	}

	function createAllFreshDb() {
		const db = openDb(":memory:");
		for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
			populateSource(db, key);
		}
		return db;
	}

	test("passes when all 15 sources succeeded and fetched today", () => {
		const db = createAllFreshDb();
		const res = assertPrerequisitesFresh(db, NOW);
		assert.equal(res.fresh, true);
		assert.equal(res.staleSources.length, 0);
	});

	test("fails when a single scrape run failed", () => {
		const db = openDb(":memory:");
		for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
			if (key === "sbcfire-news") {
				populateSource(db, key, {
					runStatus: "failure",
					errorMessage: "HTTP 500",
				});
			} else {
				populateSource(db, key);
			}
		}
		const res = assertPrerequisitesFresh(db, NOW);
		assert.equal(res.fresh, false);
		assert.equal(res.staleSources.length, 1);
		assert.equal(res.staleSources[0].sourceKey, "sbcfire-news");
		assert.match(res.staleSources[0].reason, /latest scrape run failed/);
	});

	test("fails in partial-success-then-failure case (document saved but scrape run failed)", () => {
		const db = openDb(":memory:");
		for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
			if (key === "nws-forecast") {
				populateSource(db, key, {
					runStatus: "failure",
					docFetchedAt: "2026-08-17T12:52:00.000Z",
					errorMessage: "SyntaxError",
				});
			} else {
				populateSource(db, key);
			}
		}
		const res = assertPrerequisitesFresh(db, NOW);
		assert.equal(res.fresh, false);
		assert.equal(res.staleSources.length, 1);
		assert.equal(res.staleSources[0].sourceKey, "nws-forecast");
		assert.match(res.staleSources[0].reason, /latest scrape run failed/);
	});

	test("fails when scrape run is in-flight (running)", () => {
		const db = openDb(":memory:");
		for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
			if (key === "cvusd-board") {
				populateSource(db, key, { runStatus: "running" });
			} else {
				populateSource(db, key);
			}
		}
		const res = assertPrerequisitesFresh(db, NOW);
		assert.equal(res.fresh, false);
		assert.equal(res.staleSources.length, 1);
		assert.equal(res.staleSources[0].sourceKey, "cvusd-board");
		assert.match(res.staleSources[0].reason, /in progress/);
	});

	test("fails when scrape run is from yesterday", () => {
		const db = openDb(":memory:");
		for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
			if (key === "sbclib-events") {
				populateSource(db, key, {
					runFinishedAt: "2026-08-16T12:55:00.000Z",
					docFetchedAt: "2026-08-16T12:55:00.000Z",
				});
			} else {
				populateSource(db, key);
			}
		}
		const res = assertPrerequisitesFresh(db, NOW);
		assert.equal(res.fresh, false);
		assert.equal(res.staleSources.length, 1);
		assert.equal(res.staleSources[0].sourceKey, "sbclib-events");
		assert.match(res.staleSources[0].reason, /expected 2026-08-17/);
	});

	test("fails when a source has no scrape run recorded", () => {
		const db = openDb(":memory:");
		for (const key of DAILY_BRIEF_PREREQUISITE_SOURCES) {
			if (key !== "yanksair-events") {
				populateSource(db, key);
			}
		}
		const res = assertPrerequisitesFresh(db, NOW);
		assert.equal(res.fresh, false);
		assert.equal(res.staleSources.length, 1);
		assert.equal(res.staleSources[0].sourceKey, "yanksair-events");
		assert.match(res.staleSources[0].reason, /no scrape run recorded/);
	});
});

describe("headlines elsewhere deduplication and selection", () => {
	test("jaccardSimilarity computes overlap on title token sets", () => {
		const t1 = titleTokens(
			"7-Eleven, gas station, car wash to replace Corner Bar area",
		);
		const t2 = titleTokens(
			"7-Eleven, gas station, car wash to replace Corner Bar area in Chino",
		);
		const t3 = titleTokens(
			"Ontario airport reports record passenger travel numbers",
		);

		const sim12 = jaccardSimilarity(t1, t2);
		const sim13 = jaccardSimilarity(t1, t3);

		assert.ok(sim12 >= 0.6, `expected >= 0.6, got ${sim12}`);
		assert.ok(sim13 < 0.2, `expected < 0.2, got ${sim13}`);
	});

	test("checkHeadlinesFreshness evaluates ToS status and scrape run age", () => {
		const db = openDb(":memory:");
		assert.equal(HEADLINES_SOURCES.length, 2);

		// Without any scrape runs recorded
		const freshMap1 = checkHeadlinesFreshness(db, NOW);
		assert.equal(freshMap1["champion-news"].isFresh, false);
		assert.equal(freshMap1["dailybulletin-news"].isFresh, false);

		// Populate successful scrape runs
		db.raw
			.prepare(
				`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, documents_count, items_count)
				 VALUES (?, ?, ?, 'success', 1, 1)`,
			)
			.run(
				"champion-news",
				"2026-08-15T07:50:00.000Z",
				"2026-08-15T08:00:00.000Z",
			);

		db.raw
			.prepare(
				`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, documents_count, items_count)
				 VALUES (?, ?, ?, 'success', 1, 1)`,
			)
			.run(
				"dailybulletin-news",
				"2026-08-17T05:50:00.000Z",
				"2026-08-17T06:00:00.000Z",
			);

		const freshMap2 = checkHeadlinesFreshness(db, NOW);
		assert.equal(freshMap2["champion-news"].isFresh, true);
		assert.equal(freshMap2["dailybulletin-news"].isFresh, true);
	});

	test("a ToS hold outranks a perfectly fresh scrape run", () => {
		// The terms, not the scrape, decide whether the outlet may be linked at
		// all. A hold that a successful scrape could override would let a brief
		// keep citing a publisher whose terms drifted out from under us.
		const db = openDb(":memory:");
		db.raw
			.prepare(
				`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, documents_count, items_count)
				 VALUES (?, ?, ?, 'success', 1, 1)`,
			)
			.run(
				"dailybulletin-news",
				"2026-08-17T05:50:00.000Z",
				"2026-08-17T06:00:00.000Z",
			);
		db.setSourceTosHold("dailybulletin-news", {
			reason: "terms_hash_drift",
			checkedAt: "2026-08-17T04:00:00.000Z",
		});

		const freshness = checkHeadlinesFreshness(db, NOW);
		assert.equal(freshness["dailybulletin-news"].isFresh, false);
		assert.equal(freshness["dailybulletin-news"].tosStatus, "held");
		assert.equal(
			freshness["dailybulletin-news"].heldReason,
			"terms_hash_drift",
		);
		// The run itself is still reported, so an operator can see it succeeded.
		assert.equal(freshness["dailybulletin-news"].status, "success");
	});

	test("a failed or in-flight scrape run is never fresh", () => {
		const db = openDb(":memory:");
		db.raw
			.prepare(
				`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, error_message, documents_count, items_count)
				 VALUES (?, ?, ?, 'failure', 'HTTP 503', 0, 0)`,
			)
			.run(
				"champion-news",
				"2026-08-17T05:50:00.000Z",
				"2026-08-17T06:00:00.000Z",
			);
		db.raw
			.prepare(
				`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, documents_count, items_count)
				 VALUES (?, ?, NULL, 'running', 0, 0)`,
			)
			.run("dailybulletin-news", "2026-08-17T05:50:00.000Z");

		const freshness = checkHeadlinesFreshness(db, NOW);
		assert.equal(freshness["champion-news"].isFresh, false);
		assert.match(freshness["champion-news"].heldReason ?? "", /HTTP 503/);
		assert.equal(freshness["dailybulletin-news"].isFresh, false);
		assert.equal(
			freshness["dailybulletin-news"].heldReason,
			"scrape run in progress",
		);
	});

	test("each outlet is judged stale on its own publishing cadence", () => {
		// The Champion is a weekly and the Daily Bulletin publishes daily, so one
		// staleness threshold cannot serve both. This run is ~31h old: fine for
		// the weekly's 8-day window, well past the daily's 26h one.
		const db = openDb(":memory:");
		for (const key of HEADLINES_SOURCES) {
			db.raw
				.prepare(
					`INSERT INTO scrape_runs (source_key, started_at, finished_at, status, documents_count, items_count)
					 VALUES (?, ?, ?, 'success', 1, 1)`,
				)
				.run(key, "2026-08-16T05:50:00.000Z", "2026-08-16T06:00:00.000Z");
		}

		const freshness = checkHeadlinesFreshness(db, NOW);
		assert.equal(freshness["champion-news"].isFresh, true);
		assert.equal(freshness["dailybulletin-news"].isFresh, false);
		assert.match(
			freshness["dailybulletin-news"].heldReason ?? "",
			/stale scrape run \(31\.1h old, max 26h\)/,
		);
	});

	test("selectHeadlinesElsewhere enforces recency, deduplication precedence, and capping", () => {
		const rows: ItemRow[] = [
			// 1. Champion article (local commercial dev)
			item({
				source_key: "champion-news",
				source_url:
					"https://www.championnewspapers.com/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html",
				title: "7-Eleven, gas station, car wash to replace Corner Bar area",
				body: "Evergreen Devco will propose a 7-Eleven on Central Avenue for Chino Planning Commission consideration.",
				occurred_at: "2026-08-15T00:00:00.000Z",
				meta: JSON.stringify({
					outlet: "The Champion",
					city: "Chino",
					chinoRelevant: true,
				}),
			}),
			// 2. Daily Bulletin duplicate of the same story
			item({
				source_key: "dailybulletin-news",
				source_url:
					"https://www.dailybulletin.com/2026/08/15/7-eleven-gas-station-car-wash-to-replace-corner-bar-area/",
				title:
					"7-Eleven, gas station, car wash to replace Corner Bar area in Chino",
				body: "Evergreen Devco will propose a 7-Eleven on Central Avenue.",
				occurred_at: "2026-08-15T12:00:00.000Z",
				meta: JSON.stringify({
					outlet: "Daily Bulletin",
					city: "Chino",
					chinoRelevant: true,
				}),
			}),
			// 3. Daily Bulletin public figure story (Sonja Shaw)
			item({
				source_key: "dailybulletin-news",
				source_url:
					"https://www.dailybulletin.com/2026/08/16/chino-valleys-sonja-shaw-rides-anger-over-covid-rules-to-bid-for-state-superintendent/",
				title:
					"Chino Valley's Sonja Shaw rides anger over COVID rules to bid for state superintendent",
				body: "Chino Valley school board president Sonja Shaw launched her campaign.",
				occurred_at: "2026-08-16T15:00:00.000Z",
				meta: JSON.stringify({
					outlet: "Daily Bulletin",
					city: "Chino",
					chinoRelevant: true,
				}),
			}),
			// 4. Ineligible crime story
			item({
				source_key: "dailybulletin-news",
				source_url:
					"https://www.dailybulletin.com/2026/08/16/suspect-arrested-after-burglary-in-chino/",
				title: "Suspect arrested after commercial burglary in Chino",
				body: "Police arrested a suspect.",
				occurred_at: "2026-08-16T16:00:00.000Z",
				meta: JSON.stringify({
					outlet: "Daily Bulletin",
					city: "Chino",
					chinoRelevant: true,
				}),
			}),
		];

		const freshness = {
			"champion-news": {
				isFresh: true,
				status: "success" as const,
				finishedAt: "2026-08-15T08:00:00.000Z",
				tosStatus: "enabled" as const,
			},
			"dailybulletin-news": {
				isFresh: true,
				status: "success" as const,
				finishedAt: "2026-08-17T06:00:00.000Z",
				tosStatus: "enabled" as const,
			},
		};

		const selected = selectHeadlinesElsewhere(rows, freshness, NOW);

		// Crime story must be dropped
		// Duplicate story must keep Champion version over Daily Bulletin
		assert.equal(selected.length, 2);
		assert.equal(selected[0].source_key, "dailybulletin-news"); // newer occurred_at
		assert.equal(selected[1].source_key, "champion-news"); // dedupe kept Champion
	});

	// Helper for the window/cap tests below: a policy-clean, locally relevant
	// Champion story that differs enough from its siblings to survive dedup.
	function headline(over: Partial<ItemRow>): ItemRow {
		return item({
			source_key: "champion-news",
			source_url: `https://www.championnewspapers.com/news/article_${seq}.html`,
			title: "Chino Planning Commission approves Central Avenue plan",
			body: "The project heads to Chino City Council next month.",
			occurred_at: "2026-08-16T00:00:00.000Z",
			meta: JSON.stringify({ outlet: "The Champion", city: "Chino" }),
			...over,
		});
	}

	const FRESH = {
		"champion-news": {
			isFresh: true,
			status: "success" as const,
			finishedAt: "2026-08-17T00:00:00.000Z",
			tosStatus: "enabled" as const,
		},
		"dailybulletin-news": {
			isFresh: true,
			status: "success" as const,
			finishedAt: "2026-08-17T06:00:00.000Z",
			tosStatus: "enabled" as const,
		},
	};

	test("selectHeadlinesElsewhere drops outlets whose scrape is not fresh", () => {
		const rows = [headline({}), headline({ source_key: "dailybulletin-news" })];

		const selected = selectHeadlinesElsewhere(
			rows,
			{
				...FRESH,
				"champion-news": { ...FRESH["champion-news"], isFresh: false },
			},
			NOW,
		);

		assert.equal(selected.length, 1);
		assert.equal(selected[0].source_key, "dailybulletin-news");
	});

	test("selectHeadlinesElsewhere enforces the per-outlet publishing window", () => {
		// The Champion is weekly (7 days); the Daily Bulletin is daily (48h).
		const rows = [
			headline({ occurred_at: "2026-08-12T00:00:00.000Z" }), // 5 days: in
			headline({ occurred_at: "2026-08-05T00:00:00.000Z" }), // 12 days: out
			headline({
				source_key: "dailybulletin-news",
				source_url: "https://www.dailybulletin.com/2026/08/16/recent/",
				title: "Chino Hills council reviews Peyton Drive repaving",
				occurred_at: "2026-08-16T00:00:00.000Z", // 37h: in
			}),
			headline({
				source_key: "dailybulletin-news",
				source_url: "https://www.dailybulletin.com/2026/08/13/older/",
				title: "Chino library expands weekend hours at Schaefer Avenue",
				occurred_at: "2026-08-13T00:00:00.000Z", // 4 days: out
			}),
		];

		const selected = selectHeadlinesElsewhere(rows, FRESH, NOW);
		assert.deepEqual(
			selected.map((r) => r.occurred_at),
			["2026-08-16T00:00:00.000Z", "2026-08-12T00:00:00.000Z"],
		);
	});

	test("selectHeadlinesElsewhere does not re-link what the previous brief carried", () => {
		const rows = [
			headline({
				source_key: "dailybulletin-news",
				source_url: "https://www.dailybulletin.com/2026/08/16/after/",
				title: "Chino Hills council reviews Peyton Drive repaving",
				occurred_at: "2026-08-16T18:00:00.000Z",
			}),
			headline({
				source_key: "dailybulletin-news",
				source_url: "https://www.dailybulletin.com/2026/08/16/before/",
				title: "Chino library expands weekend hours at Schaefer Avenue",
				occurred_at: "2026-08-16T06:00:00.000Z",
			}),
		];

		const selected = selectHeadlinesElsewhere(
			rows,
			FRESH,
			NOW,
			"2026-08-16T12:00:00.000Z",
		);

		assert.equal(selected.length, 1);
		assert.match(selected[0].source_url, /after/);
	});

	test("selectHeadlinesElsewhere caps at 5 total and 3 per outlet", () => {
		const titles = [
			"Chino Planning Commission approves Central Avenue plan",
			"Chino Hills opens English Springs Park splash pad",
			"Chino Valley Fire District adds Ramona Avenue engine",
			"Chino Town Square lands grocery anchor tenant",
			"Chino Airport runway resurfacing begins in September",
			"Chino Hills library extends Peyton Drive branch hours",
		];
		const rows = titles.flatMap((title, i) => [
			headline({ title, occurred_at: `2026-08-1${i % 6}T00:00:00.000Z` }),
			headline({
				source_key: "dailybulletin-news",
				source_url: `https://www.dailybulletin.com/2026/08/16/story-${i}/`,
				title: `${title} downtown`,
				occurred_at: "2026-08-16T00:00:00.000Z",
			}),
		]);

		const selected = selectHeadlinesElsewhere(rows, FRESH, NOW);

		assert.equal(selected.length, 5);
		for (const key of HEADLINES_SOURCES) {
			assert.ok(
				selected.filter((r) => r.source_key === key).length <= 3,
				`${key} exceeded its per-outlet cap`,
			);
		}
	});

	test("assembleBrief renders safe semantic HTML and attributions frontmatter", () => {
		const emptyForecast: ItemRow[] = [
			item({
				source_key: "nws-forecast",
				external_id: "SGX:2026-08-17T13:00:00Z",
				occurred_at: "2026-08-17T13:00:00.000Z",
				body: "Sunny, high 88.",
				meta: JSON.stringify({
					city: "Chino",
					periodName: "Today",
					isDaytime: true,
				}),
			}),
		];

		const headlinesRow = item({
			source_key: "champion-news",
			source_url:
				"https://www.championnewspapers.com/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html",
			title: '7-Eleven & "Gas Station" to replace Corner Bar',
			body: "Evergreen Devco will propose a 7-Eleven on Central Avenue.",
			occurred_at: "2026-08-15T00:00:00.000Z",
			meta: JSON.stringify({
				outlet: "The Champion",
				city: "Chino",
				chinoRelevant: true,
			}),
		});

		const inputs: BriefInputs = {
			forecast: emptyForecast,
			nwsAlerts: [],
			fire: [],
			calendarEvents: [],
			agendaItems: [],
			cvusdEvents: [],
			licenseEvents: [],
			headlines: [headlinesRow],
			headlinesFreshness: {
				"champion-news": {
					isFresh: true,
					status: "success",
					finishedAt: "2026-08-15T08:00:00.000Z",
					tosStatus: "enabled",
				},
			},
			publishedPosts: [],
			prevBriefPublishedAt: null,
		};

		const { post } = assembleBrief(inputs, NOW);

		// Verified: Sources does NOT contain secondary press URL
		assert.ok(!post.sources.includes(headlinesRow.source_url));
		// Verified: Attributions DOES contain secondary press URL
		assert.ok(post.attributions?.includes(headlinesRow.source_url));

		// Verified: the heading is markdown like every other section's, and the
		// list is raw HTML carrying the attribution link class
		assert.ok(post.bodyMd.includes("## Headlines elsewhere"));
		assert.ok(post.bodyMd.includes('<ul class="headlines-elsewhere">'));
		assert.ok(post.bodyMd.includes('<a class="headline-link"'));
		assert.ok(
			post.bodyMd.includes(
				"7-Eleven &amp; &quot;Gas Station&quot; to replace Corner Bar",
			),
		);
		assert.ok(post.bodyMd.includes("(The Champion)"));

		// Post rendering verification
		const rendered = renderPostFile(post, "2026-08-17T13:05:00.000Z");
		assert.ok(rendered.includes("attributions:"));
		assert.ok(rendered.includes(headlinesRow.source_url));
	});

	test("assembleBrief refuses a headline URL outside the outlet's own hosts", () => {
		// A look-alike host: "championnewspapers.com" appears in it, but it is not
		// the outlet. A substring check would have let this through to a reader.
		const impostor = item({
			source_key: "champion-news",
			source_url:
				"https://www.championnewspapers.com.evil.example/community_news/article_dead.html",
			title: "Chino Planning Commission approves Central Avenue plan",
			body: "The project heads to Chino City Council next month.",
			occurred_at: "2026-08-16T00:00:00.000Z",
			meta: JSON.stringify({ outlet: "The Champion", city: "Chino" }),
		});

		const inputs: BriefInputs = {
			forecast: [],
			nwsAlerts: [],
			fire: [],
			calendarEvents: [],
			agendaItems: [],
			cvusdEvents: [],
			licenseEvents: [],
			headlines: [impostor],
			headlinesFreshness: FRESH,
			publishedPosts: [],
			prevBriefPublishedAt: null,
		};

		const { post, notes } = assembleBrief(inputs, NOW);

		assert.ok(!post.bodyMd.includes("evil.example"));
		assert.ok(!post.bodyMd.includes("Headlines elsewhere"));
		assert.equal(post.attributions, undefined);
		assert.ok(notes.some((n) => n.includes("off-allowlist URL skipped")));
		// With nothing else to report, the empty section must not suppress the
		// quiet-morning line.
		assert.ok(post.bodyMd.includes("A quiet morning"));
	});
});
