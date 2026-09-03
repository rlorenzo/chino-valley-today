// Daily brief assembler (Phase 4 Task 4.3). One post per morning, post_type
// 'daily-brief', Tier A: deterministic template assembly, zero LLM calls.
// Reads the CURRENT database; "today" is the America/Los_Angeles calendar
// day at run time. Sections are conditional — an empty section is omitted,
// never padded — and a quiet day ships honestly (weather + schedule, labeled).
//
// Section rules that bind this file (PLAN.md 4.3, EDITORIAL.md):
// - Every rendered claim carries its item's source_url.
// - Fire & safety renders verbatim title + source link ONLY, never body text
//   (release bodies can name private individuals). sbcfire-news is a
//   county-wide feed, so it is filtered to meta.chinoRelevant (the dossier
//   leaves inclusion to the assembler); cvfd-news IS the local district and
//   is included whole. Each city's Alert Center (chino-news-rss,
//   chinohills-news-rss — item_type 'alert' only; their news_release items
//   stay out of this section) is included whole too, same as cvfd-news.
//   usgs-quakes is county-wide-by-nature like sbcfire-news and is filtered
//   to meta.chinoRelevant the same way.
//   Nixle/sheriff sources are never queried here — Tier C.
// - "Headlines elsewhere" does not exist until Task 4.2 lands; no stub.
//
// Usage: node src/pipeline/daily-brief.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Db, openDb } from "../db/index.ts";
import { filterHeadlineEligibility } from "../gates/policy-filters.ts";
import { esc } from "../html.ts";
import {
	CHAMPION_ARTICLE_PATH_RE,
	DAILY_BULLETIN_ARTICLE_PATH_RE,
} from "../scrapers/press-paths.ts";
import { ROOT } from "../store.ts";
import {
	normalizeLocation,
	normalizeTimes,
} from "../tiera/meeting-previews.ts";
import { type ItemRow, parseMeta, queryItems } from "../tiera/queries.ts";
import {
	alertEventKey,
	alertPostSlugHash,
	alertPostSlugHashOf,
	cleanTitle,
	dedupeByKey,
	dropCancelledAlerts,
	dropSupersededAlerts,
	humanDateFromLocal,
	localMeetingDate,
	mdEscape,
	mdLink,
	withinLastDays,
} from "../tiera/util.ts";
import {
	createPost,
	type NewPost,
	normalizeSlug,
	type PostRow,
	transitionPost,
} from "./posts.ts";
import { archiveUrl } from "./site-url.ts";

const LA_TZ = "America/Los_Angeles";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Calendar sources whose 'event' items feed the Today section. cvusd-board's
// event items are board meetings and are handled by the meetings selector.
const CALENDAR_SOURCES = [
	"sbclib-events",
	"sbparks-events",
	"cbwcd-events",
	"yanksair-events",
	"chino-news-rss",
	"chinohills-news-rss",
];
// usgs-quakes belongs here despite the name: an earthquake is a safety item,
// its only item_type is 'alert', and Fire & safety already renders exactly what
// a quake line needs — verbatim title plus source link, nothing else.
const FIRE_SOURCES = ["sbcfire-news", "cvfd-news", "usgs-quakes"];
// Sources whose coverage area is wider than ours, so their items are ingested
// whole and carry meta.chinoRelevant for the assembler to filter on. The fire
// feed is county-wide; the earthquake ring is 50 km and reaches Loma Linda.
const COUNTYWIDE_FIRE_SOURCES = new Set(["sbcfire-news", "usgs-quakes"]);
// Queried separately from FIRE_SOURCES (itemTypes: ["alert"] only). The city
// scrapers also produce 'news_release' and 'event' items, and FIRE_SOURCES'
// query pulls news_release + alert together, so folding the city keys into
// FIRE_SOURCES would leak city news releases into Fire & safety.
const CITY_ALERT_SOURCES = ["chino-news-rss", "chinohills-news-rss"];
const FIRE_LABEL: Record<string, string> = {
	"sbcfire-news": "San Bernardino County Fire",
	"cvfd-news": "Chino Valley Fire District",
	"chino-news-rss": "City of Chino",
	"chinohills-news-rss": "City of Chino Hills",
	"usgs-quakes": "U.S. Geological Survey",
};
const AGENDA_SOURCES = [
	"chino-legistar",
	"chino-agendacenter",
	"chinohills-agendas",
];

// Everything that varies between the secondary-press outlets lives here. The
// Champion is a weekly print paper and the Daily Bulletin publishes daily, so
// one set of windows cannot serve both — but spreading that difference across
// `if (source_key === ...)` branches is how a third outlet gets half wired up.
// `hosts` is the render-time allowlist: a link only reaches the page if its
// host is one of these exactly.
interface HeadlineSourcePolicy {
	outlet: string;
	hosts: readonly string[];
	// How stale the scrape run itself may be before the outlet is dropped.
	maxScrapeAgeHours: number;
	// How old an individual article may be and still be worth linking.
	maxItemAgeHours: number;
	// Daily outlets must not re-link what the previous brief already carried.
	sincePrevBrief: boolean;
	// Cross-outlet dedup precedence, ascending (lower wins). Replaces a
	// champion-first boolean now that there are six outlets to order, not two.
	dedupRank: number;
	// Per-outlet cap on how many of this outlet's headlines one brief may
	// carry. Defaults to MAX_HEADLINES_PER_OUTLET when omitted.
	maxPerBrief?: number;
	// The shape this outlet's article permalinks take, for the outlets we reach
	// by crawling URLs. Absent for the feed-driven outlets, whose links come
	// from the publisher's own RSS and have no path shape to assert.
	articlePathRe?: RegExp;
}

const HEADLINE_SOURCE_POLICY: Record<string, HeadlineSourcePolicy> = {
	"champion-news": {
		outlet: "The Champion",
		hosts: ["www.championnewspapers.com", "championnewspapers.com"],
		maxScrapeAgeHours: 8 * 24,
		maxItemAgeHours: 7 * 24,
		sincePrevBrief: false,
		dedupRank: 0,
		articlePathRe: CHAMPION_ARTICLE_PATH_RE,
	},
	"dailybulletin-news": {
		outlet: "Daily Bulletin",
		hosts: ["www.dailybulletin.com", "dailybulletin.com"],
		maxScrapeAgeHours: 26,
		maxItemAgeHours: 48,
		sincePrevBrief: true,
		dedupRank: 1,
		articlePathRe: DAILY_BULLETIN_ARTICLE_PATH_RE,
	},
	"quest-news": {
		outlet: "Quest News",
		hosts: ["dalquestnews.org", "www.dalquestnews.org"],
		maxScrapeAgeHours: 8 * 24,
		maxItemAgeHours: 7 * 24,
		sincePrevBrief: false,
		dedupRank: 2,
		maxPerBrief: 2,
	},
	"bulldogtimes-news": {
		outlet: "Bulldog Times",
		hosts: ["ayalabulldogtimes.org", "www.ayalabulldogtimes.org"],
		maxScrapeAgeHours: 8 * 24,
		maxItemAgeHours: 7 * 24,
		sincePrevBrief: false,
		dedupRank: 3,
		maxPerBrief: 2,
	},
	"breeze-news": {
		outlet: "The Breeze",
		hosts: ["thebreezepaper.com", "www.thebreezepaper.com"],
		maxScrapeAgeHours: 8 * 24,
		maxItemAgeHours: 7 * 24,
		sincePrevBrief: false,
		dedupRank: 4,
		maxPerBrief: 2,
	},
	"nbc4-news": {
		outlet: "NBC4 Los Angeles",
		hosts: ["www.nbclosangeles.com", "nbclosangeles.com"],
		maxScrapeAgeHours: 26,
		maxItemAgeHours: 48,
		sincePrevBrief: true,
		dedupRank: 5,
	},
};

export const HEADLINES_SOURCES = Object.keys(HEADLINE_SOURCE_POLICY);

// A publisher's clock running ahead of ours must not silently drop a story.
const MAX_ITEM_FUTURE_HOURS = 24;
// Jaccard overlap on title tokens above which two stories are the same story.
const HEADLINE_DEDUP_SIMILARITY = 0.6;
const MAX_HEADLINES_TOTAL = 5;
const MAX_HEADLINES_PER_OUTLET = 3;

const MS_PER_HOUR = 60 * 60 * 1000;

function hoursSince(nowMs: number, iso: string): number {
	return (nowMs - new Date(iso).getTime()) / MS_PER_HOUR;
}

export interface SourceFreshness {
	isFresh: boolean;
	status: "running" | "success" | "failure" | "missing";
	finishedAt: string | null;
	tosStatus: "enabled" | "held";
	heldReason?: string | null;
}

// Prerequisite sources, tiered by what their absence does to the brief.
//
// WHY TIERS
//
// This list was flat, and assertPrerequisitesFresh blocked the brief when any
// member failed. On 2026-08-20 cbwcd.org — a water district's event calendar,
// carrying compost giveaways and holiday closures — stopped answering, and no
// brief published at all that morning. Readers lost an active heat advisory,
// the day's council schedule and the forecast because a compost giveaway
// could not be confirmed.
//
// That inverted the contract the scrape layer already works under: "A source
// being down for a day is normal; it must not cost us the other twelve"
// (scripts/run-group.sh). Publishing nothing is strictly worse for a reader
// than publishing something honestly marked incomplete.
//
// So blocking is reserved for the case where publishing would be actively
// MISLEADING rather than merely thin. Only the two weather sources qualify:
// the brief renders an "Active alert" section, and a brief showing no alert
// because the alert feed failed states something false about a heat advisory
// or an evacuation. Everything else degrades with a note in the section it
// feeds — see PREREQUISITE_SECTIONS.
export const BLOCKING_PREREQUISITE_SOURCES = [
	"nws-forecast",
	"nws-alerts",
] as const;

// Stale here costs a section's completeness, never the brief's honesty: each
// one names itself in the section it feeds, so an empty Today reads as "we
// could not reach the library calendar", not "nothing is happening".
export const OPTIONAL_PREREQUISITE_SOURCES = [
	// Frequent group (05:17 PT)
	"sbcfire-news",
	"cvfd-news",
	"chino-news-rss",
	"chinohills-news-rss",
	"usgs-quakes",
	// Daily group (05:40 PT)
	"chino-legistar",
	"chino-agendacenter",
	"chinohills-agendas",
	"cvusd-board",
	"sbclib-events",
	"sbparks-events",
	"cbwcd-events",
	"yanksair-events",
	"abc-licenses",
] as const;

// The union. The check inspects every one of them, it
// just acts differently per tier.
export const DAILY_BRIEF_PREREQUISITE_SOURCES = [
	...BLOCKING_PREREQUISITE_SOURCES,
	...OPTIONAL_PREREQUISITE_SOURCES,
] as const;

// Which body section each optional source feeds. A source can feed two (the
// city RSS feeds carry both civic alerts and calendar events), so its note
// appears in each.
export type BriefSection = "fire" | "today" | "record";
export const PREREQUISITE_SECTIONS: Record<string, readonly BriefSection[]> = {
	"sbcfire-news": ["fire"],
	"cvfd-news": ["fire"],
	"chino-news-rss": ["fire", "today"],
	"chinohills-news-rss": ["fire", "today"],
	"usgs-quakes": ["fire"],
	"chino-legistar": ["today"],
	"chino-agendacenter": ["today"],
	"chinohills-agendas": ["today"],
	"cvusd-board": ["today"],
	"sbclib-events": ["today"],
	"sbparks-events": ["today"],
	"cbwcd-events": ["today"],
	"yanksair-events": ["today"],
	"abc-licenses": ["record"],
};

// Reader-facing names. The scrape key is an internal identifier; a brief that
// printed "cbwcd-events" would leak plumbing into the record.
export const PREREQUISITE_LABEL: Record<string, string> = {
	"sbcfire-news": "San Bernardino County Fire",
	"cvfd-news": "Chino Valley Fire District",
	"chino-news-rss": "City of Chino",
	"chinohills-news-rss": "City of Chino Hills",
	"usgs-quakes": "USGS earthquake feed",
	"chino-legistar": "Chino city meeting agendas",
	"chino-agendacenter": "Chino agenda center",
	"chinohills-agendas": "Chino Hills city meeting agendas",
	"cvusd-board": "CVUSD Board of Education",
	"sbclib-events": "San Bernardino County Library events",
	"sbparks-events": "San Bernardino County Parks events",
	"cbwcd-events": "Chino Basin Water Conservation District events",
	"yanksair-events": "Yanks Air Museum events",
	"abc-licenses": "ABC license filings",
};

const FARMERS_MARKET_URL = "https://heritagefarmersmarket.org/chino-hills";

export function laDateOf(occurredAt: string | null): string | null {
	return occurredAt ? localMeetingDate(occurredAt) : null;
}

// "6:00 PM" for a real instant; null for date-only values and for midnight
// Pacific, which agenda systems use as a date-carrier, not a start time —
// rendering it as "12:00 AM" would state a time the source does not mean.
export function laTimeOf(occurredAt: string | null): string | null {
	if (!occurredAt || DATE_ONLY.test(occurredAt)) return null;
	const d = new Date(occurredAt);
	if (Number.isNaN(d.getTime())) return null;
	const t = new Intl.DateTimeFormat("en-US", {
		timeZone: LA_TZ,
		hour: "numeric",
		minute: "2-digit",
	}).format(d);
	return t === "12:00 AM" ? null : t;
}

// Tribe venue strings arrive with HTML entities intact ("&#038;"); decode the
// numeric ones plus the bare ampersand at the publishing layer, where
// EDITORIAL.md says normalization of source rendering artifacts belongs.
//
// One regex pass, so decoded output is never re-scanned: a doubly-encoded
// "&#38;amp;" becomes the literal text "&amp;" instead of unescaping twice
// (CodeQL js/double-escaping). Numeric entities that would materialize
// markup or control characters stay encoded — this string lands in markdown,
// where raw HTML passes through, and a venue name has no business containing
// "<". Out-of-range code points are left alone rather than letting
// String.fromCodePoint throw mid-assembly.
export function decodeEntities(s: string): string {
	return s.replace(/&(?:#(\d+)|amp|nbsp);/g, (match, num?: string) => {
		if (num === undefined) return match === "&amp;" ? "&" : " ";
		const cp = Number(num);
		if (!Number.isInteger(cp) || cp < 0x20 || cp > 0x10ffff) return match;
		if (cp === 0x3c || cp === 0x3e) return match; // "<" and ">"
		return String.fromCodePoint(cp);
	});
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
	const v = meta[key];
	return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// --- Weather -----------------------------------------------------------------

export interface CityForecast {
	city: string;
	sourceUrl: string;
	periods: Array<{
		name: string;
		body: string;
		isDaytime: boolean;
		temperature: number | null;
		shortForecast: string | null;
	}>;
}

// Today's daytime + tonight's period per city. Rows arrive in id order;
// dedupe by external_id (grid:startTime) keeps the freshest scrape of each
// period. Among today's periods the latest-starting daytime one is "today"
// and the latest-starting nighttime one is "tonight" (so "Tonight" beats a
// stale "Overnight", and a mid-day "This Afternoon" beats the morning's
// "Today").
export function selectWeather(
	forecastItems: ItemRow[],
	now: Date,
): CityForecast[] {
	const laToday = laDateOf(now.toISOString());
	const deduped = dedupeByKey(
		forecastItems,
		(r) => r.external_id ?? r.source_url,
	);
	const byCity = new Map<string, ItemRow[]>();
	for (const row of deduped) {
		const meta = parseMeta(row.meta);
		const city = metaString(meta, "city");
		if (!city || laDateOf(row.occurred_at) !== laToday) continue;
		const list = byCity.get(city) ?? [];
		list.push(row);
		byCity.set(city, list);
	}
	const out: CityForecast[] = [];
	for (const city of [...byCity.keys()].sort()) {
		const rows = byCity.get(city) ?? [];
		const latestBy = (daytime: boolean) =>
			rows
				.filter((r) => parseMeta(r.meta).isDaytime === daytime)
				.sort((a, b) =>
					(a.occurred_at ?? "").localeCompare(b.occurred_at ?? ""),
				)
				.at(-1);
		const day = latestBy(true);
		const night = latestBy(false);
		const periods: CityForecast["periods"] = [];
		for (const row of [day, night]) {
			if (!row?.body?.trim()) continue;
			const meta = parseMeta(row.meta);
			const name = metaString(meta, "periodName");
			if (!name) continue;
			periods.push({
				name,
				body: row.body.replace(/\s+/g, " ").trim(),
				isDaytime: meta.isDaytime === true,
				temperature:
					typeof meta.temperature === "number" ? meta.temperature : null,
				shortForecast: metaString(meta, "shortForecast"),
			});
		}
		const sourceUrl = (day ?? night)?.source_url;
		if (periods.length === 0 || !sourceUrl) continue;
		out.push({ city, sourceUrl, periods });
	}
	return out;
}

// NWS shortForecast is a bounded, documented vocabulary ("Sunny", "Patchy Fog
// then Sunny", "Chance Rain Showers"), so the glyph is chosen by keyword in
// priority order — a thunderstorm outranks the rain in its own description.
// Anything unrecognised returns null and simply renders no glyph: a wrong
// picture of the weather is worse than none, and the words always carry the
// actual forecast.
export function weatherGlyph(shortForecast: string | null): string | null {
	const f = (shortForecast ?? "").toLowerCase();
	if (!f) return null;
	if (f.includes("thunder")) return "storm";
	if (f.includes("snow") || f.includes("sleet") || f.includes("wintry")) {
		return "snow";
	}
	if (f.includes("rain") || f.includes("shower") || f.includes("drizzle")) {
		return "rain";
	}
	if (f.includes("fog") || f.includes("haze") || f.includes("smoke")) {
		return "fog";
	}
	if (f.includes("wind") || f.includes("breezy")) return "wind";
	if (f.includes("partly") || f.includes("mostly sunny")) return "partly";
	if (f.includes("cloud") || f.includes("overcast")) return "cloudy";
	if (f.includes("sunny") || f.includes("clear") || f.includes("fair")) {
		return "clear";
	}
	if (f.includes("hot")) return "clear";
	return null;
}

// Decorative only: aria-hidden, because the condition is already stated in
// words immediately after it. The published markdown carries a class hook
// rather than inline SVG so the glyph can be restyled later — EDITORIAL.md
// forbids editing a post once published.
function glyphSpan(shortForecast: string | null): string {
	const name = weatherGlyph(shortForecast);
	return name ? `<span class="wx wx--${name}" aria-hidden="true"></span> ` : "";
}

// The forecast is the least urgent thing in the brief, so it earns one line
// rather than two paragraphs. When every city shares a condition the condition
// is said once and only the numbers split; when the conditions genuinely
// differ, each city is named. Composed from the structured gridpoint fields
// (temperature, shortForecast), never by parsing the prose sentence — and it
// returns null rather than guess if a city is missing either period, so the
// caller can fall back to the full forecast text.
export function renderWeatherLine(
	weather: CityForecast[],
	link: (label: string, url: string) => string,
): string | null {
	if (weather.length === 0) return null;

	const cities = weather.map((fc) => ({
		city: fc.city,
		sourceUrl: fc.sourceUrl,
		day: fc.periods.find((p) => p.isDaytime),
		night: fc.periods.find((p) => !p.isDaytime),
	}));

	// Every city needs both periods with a temperature and a condition, or the
	// condensed form would quietly drop half a city's forecast.
	const complete = cities.every(
		(c) =>
			c.day?.temperature != null &&
			c.day.shortForecast &&
			c.night?.temperature != null &&
			c.night.shortForecast,
	);
	if (!complete) return null;

	const attribution = `(NWS: ${cities
		.map((c) => link(mdEscape(c.city), c.sourceUrl))
		.join(" · ")})`;

	const joinBits = (bits: string[]): string => {
		if (bits.length === 1) return bits[0];
		if (bits.length === 2) return `${bits[0]} and ${bits[1]}`;
		return `${bits.slice(0, -1).join(", ")} and ${bits.at(-1)}`;
	};
	// Highs name their city ("95 in Chino and 90 in Chino Hills"); the lows then
	// ride the order the highs just established ("lows 69 and 65") rather than
	// repeating both city names in one sentence.
	const joinNamed = (pick: (c: (typeof cities)[number]) => number): string =>
		joinBits(cities.map((c) => `${pick(c)} in ${mdEscape(c.city)}`));
	const joinBare = (pick: (c: (typeof cities)[number]) => number): string =>
		joinBits(cities.map((c) => `${pick(c)}`));

	const sameCondition = (pick: (c: (typeof cities)[number]) => string) =>
		new Set(cities.map((c) => pick(c).toLowerCase())).size === 1;

	const dayCond = (c: (typeof cities)[number]) => c.day?.shortForecast ?? "";
	const nightCond = (c: (typeof cities)[number]) =>
		c.night?.shortForecast ?? "";

	if (sameCondition(dayCond) && sameCondition(nightCond)) {
		const day = mdEscape(dayCond(cities[0]).toLowerCase());
		const night = mdEscape(nightCond(cities[0]).toLowerCase());
		const highs = joinNamed((c) => c.day?.temperature ?? 0);
		const lows = joinBare((c) => c.night?.temperature ?? 0);
		const lowLabel = cities.length === 1 ? "low" : "lows";
		return `${glyphSpan(dayCond(cities[0]))}${day.charAt(0).toUpperCase()}${day.slice(1)} today, high ${highs}; ${night} overnight, ${lowLabel} ${lows}. ${attribution}`;
	}

	// Conditions differ, so each city has to be named with its own.
	const perCity = cities
		.map(
			(c) =>
				`${glyphSpan(dayCond(c))}**${mdEscape(c.city)}**: ${mdEscape(
					dayCond(c).toLowerCase(),
				)}, ${c.day?.temperature}/${c.night?.temperature}`,
		)
		.join(". ");
	return `${perCity}. ${attribution}`;
}

// Same "active" rule as the alert post generator (src/tiera/alerts.ts):
// meta.ends parses to an instant strictly after now. No end time = not
// active — Tier A never guesses.
export function selectActiveAlerts(
	alertItems: ItemRow[],
	now: Date,
): ItemRow[] {
	// Collapse re-issuances before filtering, or one Heat Advisory updated
	// three times reads as three separate alerts. Grouped by (event, areaDesc)
	// with the newest issuance kept: an advisory NWS extends is still one
	// advisory, and showing the superseded window beside its replacement tells
	// a reader the heat ends a day earlier than it does.
	// Cancellations come out FIRST. They carry the cancelled alert's own end
	// time, so they survive the `ends > now` filter below and would otherwise
	// render as "Active alert: The Heat Advisory has been cancelled." — and,
	// being the newest issuance of their event, they would also win
	// supersession and displace the real alert.
	const deduped = dropSupersededAlerts(
		dropCancelledAlerts(
			dedupeByKey(alertItems, (r) => r.external_id ?? r.source_url),
		),
	);
	return deduped.filter((row) => {
		if (!cleanTitle(row.title)) return false;
		const ends = metaString(parseMeta(row.meta), "ends");
		if (!ends) return false;
		const t = new Date(ends).getTime();
		return !Number.isNaN(t) && t > now.getTime();
	});
}

// --- Fire & safety -----------------------------------------------------------

export function selectFireSafety(fireItems: ItemRow[], now: Date): ItemRow[] {
	const inWindow = fireItems.filter((row) => {
		if (!cleanTitle(row.title)) return false;
		if (!withinLastDays(row.occurred_at, now, 1)) return false;
		if (COUNTYWIDE_FIRE_SOURCES.has(row.source_key)) {
			return parseMeta(row.meta).chinoRelevant === true;
		}
		return true;
	});
	return dedupeByKey(inWindow, (r) => r.source_url).sort((a, b) =>
		(b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""),
	);
}

// --- Today: events and meetings ----------------------------------------------

export interface TodayEvent {
	title: string;
	sourceUrl: string;
	timeLabel: string | null;
	venue: string | null;
	occurredAt: string;
}

// A calendar event row that passed selection: titled, and not a CBWCD
// "District Holiday" office-closure notice (a closure is not an event).
function isRenderableEvent(row: ItemRow): boolean {
	const title = cleanTitle(row.title);
	if (!title) return false;
	if (row.source_key === "cbwcd-events" && /^district holiday/i.test(title))
		return false;
	return true;
}

function eventRowToEntry(row: ItemRow): TodayEvent {
	const meta = parseMeta(row.meta);
	const allDay = meta.allDay === true;
	const civicTimes = normalizeTimes(metaString(meta, "eventTimes"));
	const timeLabel = allDay
		? "all day"
		: (civicTimes ?? laTimeOf(row.occurred_at));
	const venueRaw =
		metaString(meta, "venue") ??
		normalizeLocation(metaString(meta, "location"));
	return {
		title: cleanTitle(row.title) as string,
		sourceUrl: row.source_url,
		timeLabel,
		venue: venueRaw ? decodeEntities(venueRaw) : null,
		occurredAt: row.occurred_at ?? "",
	};
}

function byStartThenTitle(a: TodayEvent, b: TodayEvent): number {
	return (
		a.occurredAt.localeCompare(b.occurredAt) || a.title.localeCompare(b.title)
	);
}

export function selectTodayEvents(
	eventItems: ItemRow[],
	now: Date,
): TodayEvent[] {
	const laToday = laDateOf(now.toISOString());
	const todays = eventItems.filter(
		(row) => isRenderableEvent(row) && laDateOf(row.occurred_at) === laToday,
	);
	return dedupeByKey(todays, (r) => r.source_url)
		.map(eventRowToEntry)
		.sort(byStartThenTitle);
}

// YYYY-MM-DD plus N calendar days, same UTC-field arithmetic as laStartDate
// in src/scrapers/tribe-events.ts (calendar-day math, DST-proof).
function laDatePlusDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface UpcomingEvent extends TodayEvent {
	date: string; // LA calendar day the event falls on
}

// Rail times are compact: the start instant only ("06:00 PM - 08:00 PM" →
// "6:00 PM"); the brief body keeps the source's full range.
export function railTimeLabel(label: string | null): string | null {
	if (!label || label === "all day") return label;
	const start = label.split(/\s*[-–]\s*/)[0].trim();
	return start.replace(/^0(\d:)/, "$1") || null;
}

// The month ahead, exclusive of today (today's events live in the brief
// body): LA days (today, today + horizonDays], deduped by source_url.
// Rendered by the site from frontmatter, not by the markdown body — the
// calendar page shows the first week openly and the rest behind a native
// disclosure, so the horizon here is coverage, not page length.
export function selectUpcomingEvents(
	eventItems: ItemRow[],
	now: Date,
	horizonDays = 30,
): UpcomingEvent[] {
	const laToday = laDateOf(now.toISOString());
	if (!laToday) return [];
	const horizon = laDatePlusDays(laToday, horizonDays);
	const ahead = eventItems.filter((row) => {
		if (!isRenderableEvent(row)) return false;
		const day = laDateOf(row.occurred_at);
		return day !== null && day > laToday && day <= horizon;
	});
	return dedupeByKey(ahead, (r) => r.source_url)
		.map((row) => ({
			...eventRowToEntry(row),
			date: laDateOf(row.occurred_at) as string,
		}))
		.sort(byStartThenTitle);
}

export interface TodayMeeting {
	title: string;
	url: string;
	timeLabel: string | null;
}

// One line per meeting scheduled today: agenda items grouped by their parent
// document (chino-legistar / chino-agendacenter / chinohills-agendas), plus
// cvusd-board meeting events (date-only occurred_at, so no time is shown —
// Tier A never guesses one).
export function selectTodayMeetings(
	agendaItems: ItemRow[],
	cvusdEvents: ItemRow[],
	now: Date,
): TodayMeeting[] {
	const laToday = laDateOf(now.toISOString());
	const byDoc = new Map<string, ItemRow[]>();
	for (const row of agendaItems) {
		const docDay = row.doc_meeting_date ?? laDateOf(row.occurred_at);
		if (docDay !== laToday) continue;
		const list = byDoc.get(row.doc_url) ?? [];
		list.push(row);
		byDoc.set(row.doc_url, list);
	}
	const meetings: TodayMeeting[] = [];
	for (const [docUrl, rows] of byDoc) {
		const withTime = rows
			.map((r) => laTimeOf(r.occurred_at))
			.find((t) => t !== null);
		meetings.push({
			title: cleanTitle(rows[0].doc_title) ?? "Meeting agenda",
			url: docUrl,
			timeLabel: withTime ?? null,
		});
	}
	for (const row of cvusdEvents) {
		const title = cleanTitle(row.title);
		if (!title || laDateOf(row.occurred_at) !== laToday) continue;
		meetings.push({ title, url: row.source_url, timeLabel: null });
	}
	return dedupeByKey(meetings, (m) => m.url).sort((a, b) =>
		a.title.localeCompare(b.title),
	);
}

// Static recurring line, Wednesdays only. The market publishes no per-event
// data (PLAN.md 4.0), so this renders as a fixed sourced sentence.
export function isLaWednesday(now: Date): boolean {
	return (
		new Intl.DateTimeFormat("en-US", {
			timeZone: LA_TZ,
			weekday: "long",
		}).format(now) === "Wednesday"
	);
}

// --- New on the record -------------------------------------------------------

/**
 * Drops alert posts whose advisory the brief has already rendered as an
 * "Active alert" line above.
 *
 * Both sections were showing the same two heat advisories, and worse, with
 * different issuance times: the "Active alert" line carries the NEWEST
 * issuance so the end time is current, while the post keeps the EARLIEST so
 * its slug survives a re-issue. A reader saw one advisory twice, stamped two
 * different ways, and had no way to tell it was one thing.
 *
 * The join therefore cannot run on title. It runs on the rows: take every
 * issuance belonging to a currently-active advisory, hash each the way the
 * alert generator builds its slug, and drop the posts that match.
 *
 * Only alert posts for ACTIVE advisories are suppressed. A post for an
 * advisory that has since expired is genuinely new on the record and is not
 * shown anywhere else in the brief, so it stays -- unless an advisory of the
 * same (event, areaDesc) is active now, which reads as a re-issue and is
 * suppressed. That is the same tradeoff dropSupersededAlerts makes, and for
 * the same reason: `ends` moves across issuances, so yesterday's expired Heat
 * Advisory and today's active one for the same area are not distinguishable
 * from one advisory that got extended.
 */
export function dropAlertPostsShownAsActive(
	posts: PostRow[],
	activeAlerts: ItemRow[],
	allAlerts: ItemRow[],
): PostRow[] {
	if (activeAlerts.length === 0) return posts;
	const activeEvents = new Set(activeAlerts.map(alertEventKey));
	const shown = new Set(
		allAlerts
			.filter((row) => activeEvents.has(alertEventKey(row)))
			.map(alertPostSlugHash),
	);
	if (shown.size === 0) return posts;
	return posts.filter((p) => {
		if (p.post_type !== "alert") return true;
		const hash = alertPostSlugHashOf(p.slug);
		return hash === null || !shown.has(hash);
	});
}

export function selectNewRecordPosts(
	posts: PostRow[],
	sinceIso: string,
): PostRow[] {
	return posts
		.filter(
			(p) =>
				p.status === "published" &&
				p.post_type !== "daily-brief" &&
				p.published_at !== null &&
				p.published_at > sinceIso,
		)
		.sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
}

// ABC license rows share one report-page source_url, so dedupe by
// external_id (license number), not by URL.
export function selectFreshLicenseEvents(
	licenseItems: ItemRow[],
	now: Date,
): ItemRow[] {
	const inWindow = licenseItems.filter(
		(r) => cleanTitle(r.title) && withinLastDays(r.occurred_at, now, 1),
	);
	return dedupeByKey(inWindow, (r) => r.external_id ?? `${r.id}`);
}

// --- Headlines Elsewhere -----------------------------------------------------

function sourceFreshness(db: Db, key: string, nowMs: number): SourceFreshness {
	const tos = db.getSourceTosStatus(key);
	const latestRun = db.raw
		.prepare(
			`SELECT status, finished_at, error_message
			 FROM scrape_runs
			 WHERE source_key = ?
			 ORDER BY id DESC
			 LIMIT 1`,
		)
		.get(key) as
		| {
				status: "running" | "success" | "failure";
				finished_at: string | null;
				error_message: string | null;
		  }
		| undefined;

	// A ToS hold outranks everything below it: the terms, not the scrape, are
	// what decides whether we may link the outlet at all.
	if (tos.status !== "enabled") {
		return {
			isFresh: false,
			status: latestRun ? latestRun.status : "missing",
			finishedAt: latestRun?.finished_at ?? null,
			tosStatus: "held",
			heldReason: tos.heldReason ?? "baseline_held",
		};
	}

	if (!latestRun) {
		return {
			isFresh: false,
			status: "missing",
			finishedAt: null,
			tosStatus: "enabled",
			heldReason: "no scrape run recorded",
		};
	}

	if (latestRun.status !== "success" || !latestRun.finished_at) {
		return {
			isFresh: false,
			status: latestRun.status,
			finishedAt: latestRun.finished_at,
			tosStatus: "enabled",
			heldReason:
				latestRun.status === "running"
					? "scrape run in progress"
					: `scrape run failed (${latestRun.error_message ?? "unknown error"})`,
		};
	}

	const maxAgeHours = HEADLINE_SOURCE_POLICY[key].maxScrapeAgeHours;
	const ageHours = hoursSince(nowMs, latestRun.finished_at);
	if (ageHours > maxAgeHours) {
		return {
			isFresh: false,
			status: "success",
			finishedAt: latestRun.finished_at,
			tosStatus: "enabled",
			heldReason: `stale scrape run (${ageHours.toFixed(1)}h old, max ${maxAgeHours}h)`,
		};
	}

	return {
		isFresh: true,
		status: "success",
		finishedAt: latestRun.finished_at,
		tosStatus: "enabled",
	};
}

export function checkHeadlinesFreshness(
	db: Db,
	now: Date,
): Record<string, SourceFreshness> {
	const nowMs = now.getTime();
	return Object.fromEntries(
		HEADLINES_SOURCES.map((key) => [key, sourceFreshness(db, key, nowMs)]),
	);
}

const DEDUP_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"in",
	"on",
	"at",
	"for",
	"to",
	"with",
	"from",
	"by",
	"about",
	"and",
	"but",
	"or",
	"nor",
	"as",
	"if",
	"when",
	"while",
	"of",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"shall",
	"should",
]);

export function titleTokens(title: string): Set<string> {
	const words = title
		.toLowerCase()
		// \w is ASCII-only, so an accented headline tokenised badly and two
		// outlets covering the same story stopped looking similar. Same bug
		// class as the name-extraction fix in this branch. Diacritics are then
		// folded, because the case this dedup exists for is two papers writing
		// up one event — and one of them spelling it "Jose" where the other
		// writes "José" must not read as two different stories.
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !DEDUP_STOP_WORDS.has(w));
	return new Set(words);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Why a headline row must not reach a reader, or null if it may. Host and path
 * are both load-bearing: a stub permalink that 301s onto the outlet's own tag
 * archive keeps the host and loses the story, so host alone would pass it.
 *
 * Selection applies this before capping and the renderer applies it again on
 * the way out — one definition, because a row rejected only at render time has
 * already taken a slot from an article that could have filled it.
 */
function headlineUrlProblem(item: ItemRow): string | null {
	const policy = HEADLINE_SOURCE_POLICY[item.source_key];
	let url: URL;
	try {
		url = new URL(item.source_url);
	} catch {
		return `unparseable URL skipped: ${item.source_url}`;
	}
	if (url.protocol !== "https:" || !policy?.hosts.includes(url.hostname)) {
		return `off-allowlist URL skipped: ${item.source_url}`;
	}
	if (policy.articlePathRe && !policy.articlePathRe.test(url.pathname)) {
		return `non-article URL skipped: ${item.source_url}`;
	}
	return null;
}

export function selectHeadlinesElsewhere(
	headlineItems: ItemRow[] | undefined,
	freshness: Record<string, SourceFreshness> | undefined,
	now: Date,
	prevBriefPublishedAt?: string | null,
	notes?: string[],
	// Secondary-press URLs earlier briefs already carried. Empty is the honest
	// default: nothing carried means nothing is a repeat.
	alreadyCarried: ReadonlySet<string> = new Set(),
): ItemRow[] {
	if (!headlineItems || headlineItems.length === 0) return [];
	const nowMs = now.getTime();

	// 1. Freshness & ToS filter. An absent map means the caller has already
	// vouched for the items (the unit tests do); an entry that is not fresh
	// drops the whole outlet rather than shipping links we cannot vouch for.
	const eligibleByFreshness = freshness
		? headlineItems.filter((item) => freshness[item.source_key]?.isFresh)
		: headlineItems;

	// 2. Recency filter by occurred_at, per the outlet's publishing cadence.
	const inWindow = eligibleByFreshness.filter((item) => {
		const policy = HEADLINE_SOURCE_POLICY[item.source_key];
		if (!policy || !item.occurred_at) return false;
		const occurredMs = new Date(item.occurred_at).getTime();
		if (Number.isNaN(occurredMs)) return false;

		const ageHours = hoursSince(nowMs, item.occurred_at);
		if (ageHours > policy.maxItemAgeHours) return false;
		if (ageHours < -MAX_ITEM_FUTURE_HOURS) return false;

		if (policy.sincePrevBrief && prevBriefPublishedAt) {
			if (occurredMs < new Date(prevBriefPublishedAt).getTime()) return false;
		}
		return true;
	});

	// 3. URL validity. Ahead of the caps on purpose: a row the renderer would
	// refuse must not first consume one of the five slots and shut out an
	// article that could have filled it.
	const withUsableUrl = inWindow.filter((item) => {
		const problem = headlineUrlProblem(item);
		if (problem) notes?.push(`headlines: ${problem}`);
		return problem === null;
	});

	// 4. Policy & relevance filter
	const eligiblePolicy = withUsableUrl.filter(
		(item) => filterHeadlineEligibility(item).eligible,
	);

	// 5. Cross-outlet deduplication. Precedence: each outlet's dedupRank (lower
	// wins) — the local weekly's own reporting over the regional daily's
	// version of the same story, student press over the wire-service-scale
	// outlets behind them — then the earlier filing, then the lower id so runs
	// are reproducible.
	const sortedForDedup = [...eligiblePolicy].sort((a, b) => {
		const rankDiff =
			(HEADLINE_SOURCE_POLICY[a.source_key]?.dedupRank ??
				Number.MAX_SAFE_INTEGER) -
			(HEADLINE_SOURCE_POLICY[b.source_key]?.dedupRank ??
				Number.MAX_SAFE_INTEGER);
		if (rankDiff !== 0) return rankDiff;
		const dateDiff = (a.occurred_at ?? "").localeCompare(b.occurred_at ?? "");
		if (dateDiff !== 0) return dateDiff;
		return a.id - b.id;
	});

	const deduped: ItemRow[] = [];
	const seen: Array<{ tokens: Set<string>; url: string; title: string }> = [];

	for (const item of sortedForDedup) {
		const title = item.title?.trim() ?? "";
		const url = item.source_url.trim();
		const tokens = titleTokens(title);

		const isDupe = seen.some(
			(prev) =>
				prev.url === url ||
				prev.title.toLowerCase() === title.toLowerCase() ||
				jaccardSimilarity(tokens, prev.tokens) >= HEADLINE_DEDUP_SIMILARITY,
		);

		if (!isDupe) {
			seen.push({ tokens, url, title });
			deduped.push(item);
		}
	}

	// 6. Final ordering & capping. Deterministic: occurred_at DESC, title ASC,
	// id ASC — the same inputs must always produce the same brief.
	const finalSorted = [...deduped].sort((a, b) => {
		const dateDiff = (b.occurred_at ?? "").localeCompare(a.occurred_at ?? "");
		if (dateDiff !== 0) return dateDiff;
		const titleDiff = (a.title ?? "").localeCompare(b.title ?? "");
		if (titleDiff !== 0) return titleDiff;
		return a.id - b.id;
	});

	const result: ItemRow[] = [];
	const countByOutlet: Record<string, number> = {};

	const fill = (rows: ItemRow[]): void => {
		for (const item of rows) {
			if (result.length >= MAX_HEADLINES_TOTAL) break;
			const cap =
				HEADLINE_SOURCE_POLICY[item.source_key]?.maxPerBrief ??
				MAX_HEADLINES_PER_OUTLET;
			const count = countByOutlet[item.source_key] ?? 0;
			if (count >= cap) continue;

			countByOutlet[item.source_key] = count + 1;
			result.push(item);
		}
	};

	// Unseen headlines claim the slots first, then already-run ones fill what is
	// left. Both caps still apply across the two passes, so a quiet week fills
	// the section as before instead of shrinking to whatever happens to be new.
	// Ordering within each pass is untouched — this decides which items make the
	// cut, not how they are sorted.
	fill(finalSorted.filter((item) => !alreadyCarried.has(item.source_url)));
	fill(finalSorted.filter((item) => alreadyCarried.has(item.source_url)));

	return result;
}

/**
 * Renders the selected headlines as <li> markup and collects the URLs that go
 * into frontmatter `attributions`. Re-applies `headlineUrlProblem` as the last
 * gate before a reader: selection already dropped these rows, but callers can
 * hand this function a list selection never saw.
 */
function renderHeadlineListItems(
	headlines: ItemRow[],
	notes: string[],
): { listItems: string[]; attributions: string[] } {
	const listItems: string[] = [];
	const attributions: string[] = [];

	for (const h of headlines) {
		const problem = headlineUrlProblem(h);
		if (problem) {
			notes.push(`headlines: ${problem}`);
			continue;
		}

		attributions.push(h.source_url);

		const policy = HEADLINE_SOURCE_POLICY[h.source_key];
		const outlet = metaString(parseMeta(h.meta), "outlet") ?? policy?.outlet;
		const teaser = h.body?.trim() ? ` &mdash; ${esc(h.body.trim())}` : "";

		// `headline-link` opts the anchor out of the violet source-stamp styling:
		// these links are attribution, not provenance.
		listItems.push(
			`  <li><a class="headline-link" href="${esc(h.source_url.trim())}" rel="noopener noreferrer">${esc(h.title?.trim() ?? "")}</a> (${esc(outlet)})${teaser}</li>`,
		);
	}

	return { listItems, attributions };
}

// --- Assembly ----------------------------------------------------------------

export interface BriefInputs {
	forecast: ItemRow[];
	nwsAlerts: ItemRow[];
	fire: ItemRow[];
	calendarEvents: ItemRow[];
	agendaItems: ItemRow[];
	cvusdEvents: ItemRow[];
	licenseEvents: ItemRow[];
	headlines?: ItemRow[];
	headlinesFreshness?: Record<string, SourceFreshness>;
	// Secondary-press URLs earlier published briefs already carried, so a
	// re-shown story can be demoted rather than presented as new.
	alreadyCarriedUrls?: ReadonlySet<string>;
	publishedPosts: PostRow[];
	// published_at of the previous daily brief; null on the first ever run,
	// which falls back to a 24h window for "new on the record".
	// Optional prerequisite sources that failed this morning, by scrape key.
	// assembleBrief turns these into a note in each section they feed.
	degradedSources?: string[];
	prevBriefPublishedAt: string | null;
}

export function assembleBrief(
	inputs: BriefInputs,
	now: Date,
	// Resolves a post's display title; injected so assembly stays pure. The
	// orchestrator passes a frontmatter reader; the fallback rebuilds a label
	// from the slug.
	titleFor: (p: PostRow) => string = postTitleFromSlug,
): { post: NewPost; notes: string[] } {
	const laToday = laDateOf(now.toISOString());
	if (!laToday) throw new Error("could not compute today's LA calendar date");
	const notes: string[] = [];

	// Optional prerequisite sources that failed, grouped by the section each
	// feeds. A degraded section must still RENDER: the entire point is that a
	// reader can tell "we could not reach this" apart from "nothing happened".
	const degradedKeys = inputs.degradedSources ?? [];
	const degradedBySection = new Map<BriefSection, string[]>();
	for (const key of degradedKeys) {
		for (const section of PREREQUISITE_SECTIONS[key] ?? []) {
			const labels = degradedBySection.get(section) ?? [];
			labels.push(PREREQUISITE_LABEL[key] ?? key);
			degradedBySection.set(section, labels);
		}
	}
	const isDegraded = (section: BriefSection): boolean =>
		(degradedBySection.get(section)?.length ?? 0) > 0;
	const degradedNote = (section: BriefSection): string[] => {
		const labels = degradedBySection.get(section);
		if (!labels || labels.length === 0) return [];
		const subject = labels.length === 1 ? "That source" : "Those sources";
		return [
			`*Not checked this morning: ${labels.map(mdEscape).join("; ")}. ${subject} did not answer, so this section may be incomplete.*`,
			"",
		];
	};
	const sources: string[] = [];
	const cite = (url: string) => {
		sources.push(url);
		return url;
	};

	// Each section builds its own lines; the single ORDER list below is what
	// decides where they land. Reordering the brief is a one-line change there,
	// not a rearrangement of this whole function.
	const body: string[] = [];
	const alertLines: string[] = [];
	const fireLines: string[] = [];
	const pressLines: string[] = [];
	const recordLines: string[] = [];
	const weatherLines: string[] = [];
	const todayLines: string[] = [];

	// Weather: one condensed line, with the full forecast text as the fallback
	// when a city is missing a period and the line cannot be composed honestly.
	const weather = selectWeather(inputs.forecast, now);
	const weatherLine = renderWeatherLine(weather, (label, url) =>
		mdLink(label, cite(url)),
	);
	if (weather.length > 0) {
		// It needed no heading when it opened the brief as the lede. Sitting
		// mid-document above the calendar, an unheaded line reads as an orphan
		// sentence trailing the section above it.
		weatherLines.push("## Weather", "");
	}
	if (weatherLine) {
		weatherLines.push(weatherLine, "");
	} else {
		for (const cityFc of weather) {
			const text = cityFc.periods
				.map((p) => `${p.name}: ${mdEscape(p.body)}`)
				.join(" ");
			weatherLines.push(
				`**${mdEscape(cityFc.city)}** — ${text} (${mdLink("NWS forecast", cite(cityFc.sourceUrl))})`,
				"",
			);
		}
	}
	const activeAlerts = selectActiveAlerts(inputs.nwsAlerts, now);
	for (const alert of activeAlerts) {
		// The advisory text is prose and the LINK LABEL is short. Citation
		// links in prose render as a nowrap badge, so putting a 90-character
		// advisory title inside one produced a badge too wide to wrap that
		// overflowed the column and crossed into the calendar rail.
		// Cites the archive page, not alert.source_url — the same link the alert
		// POST carries (src/tiera/alerts.ts), so the brief and the post send a
		// reader to the same readable record instead of one of them landing on
		// raw CAP JSON. The label stays "NWS": the page is a mirror of the
		// Weather Service's own document and says so at the top.
		alertLines.push(
			`**Active alert:** ${mdEscape((alert.title ?? "").trim())} (${mdLink("NWS", cite(archiveUrl(alert.doc_content_hash, alert.external_id)))})`,
			"",
		);
	}
	notes.push(
		`weather: ${weather.length} city forecast(s), ${activeAlerts.length} active alert(s)${weatherLine ? "" : " (condensed line unavailable; used full text)"}`,
	);

	// Fire & safety: verbatim title + source link only — never body text.
	const fire = selectFireSafety(inputs.fire, now);
	if (fire.length > 0 || isDegraded("fire")) {
		fireLines.push("## Fire & safety", "");
		for (const row of fire) {
			const label = FIRE_LABEL[row.source_key] ?? row.source_key;
			fireLines.push(
				`- ${mdLink((row.title ?? "").trim(), cite(row.source_url))} (${label})`,
			);
		}
		// Only separate from the list when there IS a list; otherwise the note
		// would sit under a heading behind two blank lines.
		if (fire.length > 0) fireLines.push("");
		fireLines.push(...degradedNote("fire"));
	}
	notes.push(`fire & safety: ${fire.length} item(s) in the last 24h`);

	// Today: meetings first, then events, then the Wednesday market line.
	const meetings = selectTodayMeetings(
		inputs.agendaItems,
		inputs.cvusdEvents,
		now,
	);
	const events = selectTodayEvents(inputs.calendarEvents, now);
	const marketDay = isLaWednesday(now);
	if (
		meetings.length > 0 ||
		events.length > 0 ||
		marketDay ||
		isDegraded("today")
	) {
		todayLines.push("## Today", "");
		for (const m of meetings) {
			const time = m.timeLabel ? ` — ${m.timeLabel}` : "";
			todayLines.push(`- **Meeting:** ${mdLink(m.title, cite(m.url))}${time}`);
		}
		for (const e of events) {
			const time = e.timeLabel ? `${e.timeLabel} — ` : "";
			const venue = e.venue ? ` at ${mdEscape(e.venue)}` : "";
			todayLines.push(`- ${time}${mdLink(e.title, cite(e.sourceUrl))}${venue}`);
		}
		if (marketDay) {
			todayLines.push(
				`- Heritage Farmers Market, every Wednesday 3:30–7:30pm at the Shoppes (${mdLink("heritagefarmersmarket.org", cite(FARMERS_MARKET_URL))})`,
			);
		}
		if (meetings.length > 0 || events.length > 0 || marketDay)
			todayLines.push("");
		todayLines.push(...degradedNote("today"));
	}
	notes.push(`today: ${meetings.length} meeting(s), ${events.length} event(s)`);

	// The week ahead, as structured frontmatter for the site's "coming up"
	// rail. Not rendered into the body — the body is today's brief; the rail
	// is layout. Their source URLs still join the post's provenance union.
	const upcoming = selectUpcomingEvents(inputs.calendarEvents, now);
	const eventsAhead = upcoming.map((e) => ({
		date: e.date,
		time: railTimeLabel(e.timeLabel),
		title: e.title,
		venue: e.venue,
		url: cite(e.sourceUrl),
	}));
	notes.push(`coming up: ${upcoming.length} event(s) in the next 30 days`);

	// New on the record: posts published since the previous brief (internal
	// links — their provenance lives on the posts themselves), plus fresh
	// license events (title + link; business principals in the context of
	// their own license are the public-role exception, per EDITORIAL.md).
	const sinceIso =
		inputs.prevBriefPublishedAt ??
		new Date(now.getTime() - 86400000).toISOString();
	const newPosts = dropAlertPostsShownAsActive(
		selectNewRecordPosts(inputs.publishedPosts, sinceIso),
		activeAlerts,
		inputs.nwsAlerts,
	);
	const licenses = selectFreshLicenseEvents(inputs.licenseEvents, now);
	if (newPosts.length > 0 || licenses.length > 0 || isDegraded("record")) {
		recordLines.push("## New on the record", "");
		for (const p of newPosts) {
			// normalizeSlug, not p.slug: the site publishes a post at its
			// lowercased slug, and this link is built from the stored one. They
			// agree for rows written since createPost() started normalizing; this
			// keeps the link right for any row written before it.
			recordLines.push(
				`- [${mdEscape(titleFor(p))}](/posts/${normalizeSlug(p.slug)}/)`,
			);
		}
		for (const row of licenses) {
			recordLines.push(
				`- ${mdLink((row.title ?? "").trim(), cite(row.source_url))}`,
			);
		}
		if (newPosts.length > 0 || licenses.length > 0) recordLines.push("");
		recordLines.push(...degradedNote("record"));
	}
	notes.push(
		`new on the record: ${newPosts.length} post(s) since ${sinceIso}, ${licenses.length} license event(s)`,
	);

	// In the local press: secondary community press reporting (The Champion,
	// Daily Bulletin). URLs join frontmatter attributions[], NEVER sources[].
	const alreadyCarried = inputs.alreadyCarriedUrls ?? new Set<string>();
	const headlines = selectHeadlinesElsewhere(
		inputs.headlines,
		inputs.headlinesFreshness,
		now,
		inputs.prevBriefPublishedAt,
		notes,
		alreadyCarried,
	);

	// Demote, do not drop. The Champion is a weekly, so its stories stay
	// eligible for seven days and the section would empty out six mornings in
	// seven if a repeat were simply dropped. What was wrong was presenting a
	// story a reader already saw as though it were new.
	const fresh = headlines.filter((h) => !alreadyCarried.has(h.source_url));
	const stillRunning = headlines.filter((h) =>
		alreadyCarried.has(h.source_url),
	);
	const freshRender = renderHeadlineListItems(fresh, notes);
	const stillRender = renderHeadlineListItems(stillRunning, notes);
	const attributions = [
		...freshRender.attributions,
		...stillRender.attributions,
	];

	// The headings are markdown like every other section's, so they inherit the
	// same .prose h2 treatment; only the lists need raw HTML, for the anchor
	// attributes markdown links cannot carry.
	const pressSection = (heading: string, listItems: string[]): void => {
		if (listItems.length === 0) return;
		pressLines.push(
			heading,
			"",
			'<ul class="headlines-elsewhere">',
			...listItems,
			"</ul>",
			"",
		);
	};
	// Each heading appears only when it has something under it, the same
	// conditional-section rule the rest of the brief follows: on a week where
	// everything has already run, the reader sees only "Still in the local
	// press this week" rather than an empty "In the local press" above it.
	pressSection("## In the local press", freshRender.listItems);
	pressSection("## Still in the local press this week", stillRender.listItems);

	const shownCount =
		freshRender.listItems.length + stillRender.listItems.length;
	notes.push(
		`headlines elsewhere: ${shownCount} headline(s) selected (${freshRender.listItems.length} new, ${stillRender.listItems.length} still running)`,
	);
	if (degradedKeys.length > 0) {
		notes.push(
			`degraded: ${degradedKeys.length} optional source(s) stale — ${degradedKeys.join(", ")}`,
		);
	}

	// THE ORDER OF THE BRIEF. Anything time-critical first: an active weather
	// alert or an overnight incident outranks everything. Then what a reader
	// came to read — other outlets' reporting, then our own new record. The
	// forecast is reference material, not news, so it sits just above today's
	// calendar rather than opening the page.
	body.push(
		...alertLines,
		...fireLines,
		...pressLines,
		...recordLines,
		...weatherLines,
		...todayLines,
	);

	// A quiet day ships honestly: weather + schedule, plainly labeled. The
	// label states what the morning is, not a roll call of alarming things
	// that didn't happen — the omitted sections already say the rest.
	if (
		fire.length === 0 &&
		newPosts.length === 0 &&
		licenses.length === 0 &&
		// Both press sections: a morning carrying only already-run stories is
		// still a morning with something to read, so it is not "quiet".
		shownCount === 0 &&
		// A morning with an unreachable source is not a quiet morning; it is
		// an unknown one. The section notes already say which.
		degradedKeys.length === 0
	) {
		const hasSchedule = meetings.length > 0 || events.length > 0 || marketDay;
		body.push(
			hasSchedule
				? "*A quiet morning — nothing new beyond the forecast and today's schedule.*"
				: "*A quiet morning — nothing new beyond the forecast.*",
			"",
		);
	}

	const post: NewPost = {
		slug: `${laToday}-daily-brief`,
		postType: "daily-brief",
		tier: "A",
		title: `Daily Brief — ${humanDateFromLocal(laToday)}`,
		bodyMd: body.join("\n").trim(),
		briefDate: laToday,
		eventsAhead,
		sources: [...new Set(sources)],
		attributions:
			attributions.length > 0 ? [...new Set(attributions)] : undefined,
	};
	return { post, notes };
}

// Fallback display title: the slug's non-date remainder. Used when the
// post's markdown file cannot be read.
export function postTitleFromSlug(p: PostRow): string {
	const rest = p.slug
		.replace(/^\d{4}-\d{2}-\d{2}-/, "")
		.replace(/^\d{4}-W\d{2}-/, "");
	const words = rest.replace(/-/g, " ").trim();
	return words.length > 0 ? words : p.slug;
}

// The real title lives in the post file's frontmatter, written by
// renderPostFile() as a JSON string literal (`title: "..."`), so it parses
// back with JSON.parse. Titles are not stored in the posts table.
/**
 * The secondary-press URLs a published brief carried, read back out of its
 * frontmatter `attributions:` block. That list is written by
 * renderHeadlineListItems and by nothing else, so it is an exact record of
 * which headlines that morning's readers were shown — no separate table needed.
 *
 * A brief whose file is missing or unreadable contributes nothing rather than
 * throwing: the cost of being wrong here is re-showing a headline as new, which
 * is the status quo, not a broken brief.
 */
export function briefAttributionsFromFile(
	p: Pick<PostRow, "file_path">,
): string[] {
	try {
		const text = readFileSync(join(ROOT, p.file_path), "utf8");
		// Frontmatter only: bail at the closing delimiter so a body that happens
		// to contain "attributions:" cannot be read as the list. A file with no
		// closing delimiter — truncated mid-write, hand-edited — would otherwise
		// hand the whole body back as "frontmatter", and a URL quoted in prose
		// would silently join the already-carried set and suppress a real
		// headline. Fewer than three parts is not frontmatter; treat it as none.
		const parts = text.split(/^---\s*$/m);
		if (parts.length < 3 || parts[0].trim() !== "") return [];
		const fm = parts[1];
		if (!fm) return [];
		// Scanned line by line rather than matched as one block: the list is the
		// last key in the frontmatter, so a block regex needs an end-of-input
		// anchor — and JS has no \Z. It is an identity escape for a literal "Z",
		// so the pattern compiles, never matches, and returns nothing quietly.
		const urls: string[] = [];
		let inList = false;
		for (const line of fm.split("\n")) {
			if (!inList) {
				if (/^attributions:\s*$/.test(line)) inList = true;
				continue;
			}
			// The list ends at the next top-level key.
			if (line.trim() !== "" && !/^\s/.test(line)) break;
			const m = line.match(/^\s+-\s+(".*")\s*$/);
			// Written with JSON.stringify (posts.ts `y`), so it parses back the
			// same way. A line that does not is skipped, not guessed at.
			if (!m) continue;
			try {
				const url = JSON.parse(m[1]) as string;
				if (typeof url === "string" && url) urls.push(url);
			} catch {
				// not a quoted string; skip
			}
		}
		return urls;
	} catch {
		return [];
	}
}

export function postTitleFromFile(p: PostRow): string {
	try {
		const text = readFileSync(join(ROOT, p.file_path), "utf8");
		const m = text.match(/^title:\s*(".*")\s*$/m);
		if (m) return JSON.parse(m[1]) as string;
	} catch {
		// fall through to the slug-derived label
	}
	return postTitleFromSlug(p);
}

// --- Orchestration -----------------------------------------------------------

export function buildDailyBrief(
	db: Db,
	now: Date,
	// Optional prerequisite sources that failed, by scrape key. Passed in
	// rather than recomputed: main() has already run the freshness check to
	// decide whether to publish at all, and a second scan of scrape_runs could
	// disagree with the first if a scrape lands between them — the run would
	// then log one degraded set and render another.
	degradedSources: string[] = [],
): { post: NewPost; notes: string[] } {
	const laToday = laDateOf(now.toISOString());
	const prev = db.raw
		.prepare(
			`SELECT published_at FROM posts
       WHERE post_type = 'daily-brief' AND status = 'published'
         AND slug != ? AND published_at IS NOT NULL
       ORDER BY published_at DESC LIMIT 1`,
		)
		.get(`${laToday}-daily-brief`) as { published_at: string } | undefined;

	// Which secondary-press URLs earlier briefs already showed. Bounded to the
	// longest eligibility window any outlet has (The Champion's 7 days) plus a
	// day of slack: a story older than that cannot be selected anyway, so
	// reading further back would only add file reads. Today's own brief is
	// excluded — regenerating a brief in place must not make its own headlines
	// look like repeats of themselves.
	const carriedSince = laDateOf(
		new Date(now.getTime() - 8 * 86400000).toISOString(),
	);
	// file_path is the only column briefAttributionsFromFile reads, and asking
	// for it alone is what lets the result type be honest — SELECT * would need
	// an `as unknown as PostRow[]` cast asserting columns nothing here touches.
	const priorBriefs = db.raw
		.prepare(
			`SELECT file_path FROM posts
       WHERE post_type = 'daily-brief' AND status = 'published'
         AND slug != ? AND published_at IS NOT NULL
         AND published_at >= ?
       ORDER BY published_at DESC`,
		)
		.all(`${laToday}-daily-brief`, carriedSince) as Array<{
		file_path: string;
	}>;
	const alreadyCarriedUrls = new Set(
		priorBriefs.flatMap((p) => briefAttributionsFromFile(p)),
	);

	const headlinesFreshness = checkHeadlinesFreshness(db, now);

	const inputs: BriefInputs = {
		forecast: queryItems(db, {
			sourceKeys: ["nws-forecast"],
			itemTypes: ["forecast_period"],
		}),
		nwsAlerts: queryItems(db, {
			sourceKeys: ["nws-alerts"],
			itemTypes: ["alert"],
		}),
		fire: [
			...queryItems(db, {
				sourceKeys: FIRE_SOURCES,
				itemTypes: ["news_release", "alert"],
			}),
			...queryItems(db, {
				sourceKeys: CITY_ALERT_SOURCES,
				itemTypes: ["alert"],
			}),
		],
		calendarEvents: queryItems(db, {
			sourceKeys: CALENDAR_SOURCES,
			itemTypes: ["event"],
		}),
		agendaItems: queryItems(db, {
			sourceKeys: AGENDA_SOURCES,
			itemTypes: ["agenda_item"],
		}),
		cvusdEvents: queryItems(db, {
			sourceKeys: ["cvusd-board"],
			itemTypes: ["event"],
		}),
		licenseEvents: queryItems(db, {
			sourceKeys: ["abc-licenses"],
			itemTypes: ["license_event"],
		}),
		headlines: queryItems(db, {
			sourceKeys: [...HEADLINES_SOURCES],
			itemTypes: ["news_article"],
		}),
		headlinesFreshness,
		alreadyCarriedUrls,
		publishedPosts: db.raw
			.prepare("SELECT * FROM posts WHERE status = 'published'")
			.all() as unknown as PostRow[],
		degradedSources,
		prevBriefPublishedAt: prev?.published_at ?? null,
	};
	return assembleBrief(inputs, now, postTitleFromFile);
}

export interface PrereqCheckResult {
	// True only when nothing at all is stale. This is the honest answer to
	// "is the record complete?" — it is NOT the publish decision any more.
	// Callers deciding whether to hold the brief must read `blocked`, or a
	// newly-optional source will quietly start blocking again.
	fresh: boolean;
	// Stale sources whose absence would make the brief MISLEADING. Non-empty
	// means: do not publish.
	blocked: boolean;
	blockingSources: Array<{ sourceKey: string; reason: string }>;
	// Stale sources the brief ships without, each annotated in its section.
	degradedSources: Array<{ sourceKey: string; reason: string }>;
	// Both tiers together, for logging.
	staleSources: Array<{ sourceKey: string; reason: string }>;
}

export function assertPrerequisitesFresh(
	db: Db,
	now: Date,
	prereqSources: readonly string[] = DAILY_BRIEF_PREREQUISITE_SOURCES,
): PrereqCheckResult {
	const laToday = laDateOf(now.toISOString());
	const staleSources: Array<{ sourceKey: string; reason: string }> = [];

	for (const key of prereqSources) {
		const latestRun = db.raw
			.prepare(
				`SELECT status, finished_at, error_message
				 FROM scrape_runs
				 WHERE source_key = ?
				 ORDER BY id DESC
				 LIMIT 1`,
			)
			.get(key) as
			| {
					status: string;
					finished_at: string | null;
					error_message: string | null;
			  }
			| undefined;

		if (!latestRun) {
			staleSources.push({
				sourceKey: key,
				reason: "no scrape run recorded",
			});
			continue;
		}

		if (latestRun.status === "running") {
			staleSources.push({
				sourceKey: key,
				reason: "scrape run is in progress",
			});
			continue;
		}

		if (latestRun.status !== "success") {
			staleSources.push({
				sourceKey: key,
				reason: `latest scrape run failed (${latestRun.error_message ?? "unknown error"})`,
			});
			continue;
		}

		if (laDateOf(latestRun.finished_at) !== laToday) {
			staleSources.push({
				sourceKey: key,
				reason: `latest scrape completed on ${laDateOf(latestRun.finished_at) ?? "unknown"}, expected ${laToday}`,
			});
			continue;
		}

		const latestDoc = db.raw
			.prepare(
				`SELECT d.fetched_at
				 FROM documents d
				 JOIN sources s ON d.source_id = s.id
				 WHERE s.key = ?
				 ORDER BY d.id DESC
				 LIMIT 1`,
			)
			.get(key) as { fetched_at: string } | undefined;

		if (!latestDoc) {
			staleSources.push({
				sourceKey: key,
				reason: "no documents recorded for source",
			});
			continue;
		}

		if (laDateOf(latestDoc.fetched_at) !== laToday) {
			staleSources.push({
				sourceKey: key,
				reason: `latest document fetched on ${laDateOf(latestDoc.fetched_at) ?? "unknown"}, expected ${laToday}`,
			});
		}
	}

	// Partition by tier. A blocking source is one whose silence would let the
	// brief assert something false; everything else is a gap we can label.
	const blockingKeys = new Set<string>(BLOCKING_PREREQUISITE_SOURCES);
	const blockingSources = staleSources.filter((s) =>
		blockingKeys.has(s.sourceKey),
	);
	const degradedSources = staleSources.filter(
		(s) => !blockingKeys.has(s.sourceKey),
	);

	return {
		fresh: staleSources.length === 0,
		blocked: blockingSources.length > 0,
		blockingSources,
		degradedSources,
		staleSources,
	};
}

function main(): void {
	const db = openDb();
	const now = new Date();

	// Machine-readable list for scripts/run-brief.sh, which re-SCRAPES these
	// between attempts. One key per line, nothing else on stdout.
	if (process.argv.includes("--list-blocking-stale")) {
		const check = assertPrerequisitesFresh(db, now);
		for (const s of check.blockingSources) console.log(s.sourceKey);
		return;
	}

	if (process.argv.includes("--check-prereqs")) {
		const check = assertPrerequisitesFresh(db, now);
		// Degraded sources are reported on every path, including success:
		// shipping a thinner brief is normal, but it must never be silent.
		for (const s of check.degradedSources) {
			console.warn(`  degraded (optional): ${s.sourceKey}: ${s.reason}`);
		}
		if (check.blocked) {
			console.error(
				`Prerequisite freshness check FAILED (${check.blockingSources.length} blocking source(s) not fresh):`,
			);
			for (const s of check.blockingSources) {
				console.error(`  - ${s.sourceKey}: ${s.reason}`);
			}
			process.exitCode = 1;
			return;
		}
		console.log(
			check.fresh
				? `Prerequisite freshness check OK: all ${DAILY_BRIEF_PREREQUISITE_SOURCES.length} sources fresh for ${laDateOf(now.toISOString())}.`
				: `Prerequisite freshness check OK (degraded): ${check.degradedSources.length} optional source(s) stale, all ${BLOCKING_PREREQUISITE_SOURCES.length} blocking source(s) fresh for ${laDateOf(now.toISOString())}.`,
		);
		return;
	}

	console.log(`Daily brief run started at ${now.toISOString()}`);
	// Defence in depth. run-brief.sh gates before calling us, but the
	// assembler is also run by hand during an incident — which is exactly when
	// publishing a brief that silently omits an active alert would do harm.
	const prereqs = assertPrerequisitesFresh(db, now);
	if (prereqs.blocked) {
		console.error(
			`  ERROR: ${prereqs.blockingSources.length} blocking source(s) not fresh — no brief published:`,
		);
		for (const s of prereqs.blockingSources) {
			console.error(`    - ${s.sourceKey}: ${s.reason}`);
		}
		process.exitCode = 1;
		return;
	}
	for (const s of prereqs.degradedSources) {
		console.warn(`  degraded (optional): ${s.sourceKey}: ${s.reason}`);
	}

	const { post, notes } = buildDailyBrief(
		db,
		now,
		prereqs.degradedSources.map((x) => x.sourceKey),
	);
	for (const note of notes) console.log(`  note: ${note}`);

	if (post.sources.length === 0) {
		// No forecast, no schedule, nothing at all — publishing an empty shell
		// would violate the non-empty sources rule. Fail closed and loudly.
		console.error(
			"  ERROR: no citable items at all (is the forecast scraper running?) — no brief published.",
		);
		process.exitCode = 1;
		return;
	}

	// Idempotent per day: re-running replaces today's queued/published brief.
	const { outcome } = createPost(db, post, { replacePublished: true });
	if (outcome === "skipped") {
		console.log(`  ${post.slug}: skipped (rejected by a human; not recreated)`);
		return;
	}
	transitionPost(db, post.slug, "published");
	console.log(`  ${post.slug}: ${outcome} -> published`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
