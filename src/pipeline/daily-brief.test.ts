import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ItemRow } from "../tiera/queries.ts";
import {
	assembleBrief,
	type BriefInputs,
	isLaWednesday,
	laTimeOf,
	postTitleFromFile,
	selectActiveAlerts,
	selectFireSafety,
	selectFreshLicenseEvents,
	selectNewRecordPosts,
	selectTodayEvents,
	selectTodayMeetings,
	selectWeather,
} from "./daily-brief.ts";
import type { PostRow } from "./posts.ts";

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
	test("reads the real frontmatter title, falling back to slug words", () => {
		const real = post({
			slug: "2026-W33-news-digest",
			file_path: "content/published/2026-W33-news-digest.md",
		});
		assert.equal(
			postTitleFromFile(real),
			"Chino Valley News Digest — 2026-W33",
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
		assert.match(p.bodyMd, /A quiet morning:/);
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
		assert.ok(p.sources.includes("https://sbcfire.org/veg-fire"));
		assert.equal(new Set(p.sources).size, p.sources.length);
	});

	test("the farmers market line renders on Wednesdays only, with its source", () => {
		const monday = assembleBrief(quietInputs(), NOW);
		assert.doesNotMatch(monday.post.bodyMd, /Heritage Farmers Market/);
		const wednesday = assembleBrief(quietInputs(), WEDNESDAY);
		assert.equal(wednesday.post.slug, "2026-08-19-daily-brief");
		assert.doesNotMatch(wednesday.post.bodyMd, /A quiet morning:.*schedule/);
		assert.match(wednesday.post.bodyMd, /Heritage Farmers Market/);
		assert.ok(
			wednesday.post.sources.includes(
				"https://heritagefarmersmarket.org/chino-hills",
			),
		);
		assert.ok(isLaWednesday(WEDNESDAY));
		assert.ok(!isLaWednesday(NOW));
	});
});
