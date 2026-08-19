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
//   is included whole. Nixle/sheriff sources are never queried here — Tier C.
// - "Headlines elsewhere" does not exist until Task 4.2 lands; no stub.
//
// Usage: node src/pipeline/daily-brief.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Db, openDb } from "../db/index.ts";
import { filterHeadlineEligibility } from "../gates/policy-filters.ts";
import { esc } from "../html.ts";
import { ROOT } from "../store.ts";
import {
	normalizeLocation,
	normalizeTimes,
} from "../tiera/meeting-previews.ts";
import { type ItemRow, parseMeta, queryItems } from "../tiera/queries.ts";
import {
	cleanTitle,
	dedupeByKey,
	humanDateFromLocal,
	localMeetingDate,
	mdEscape,
	mdLink,
	withinLastDays,
} from "../tiera/util.ts";
import {
	createPost,
	type NewPost,
	type PostRow,
	transitionPost,
} from "./posts.ts";

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
const FIRE_SOURCES = ["sbcfire-news", "cvfd-news"];
const FIRE_LABEL: Record<string, string> = {
	"sbcfire-news": "San Bernardino County Fire",
	"cvfd-news": "Chino Valley Fire District",
};
const AGENDA_SOURCES = [
	"chino-legistar",
	"chino-agendacenter",
	"chinohills-agendas",
];

// Everything that varies between the two secondary-press outlets lives here.
// The Champion is a weekly print paper and the Daily Bulletin publishes daily,
// so one set of windows cannot serve both — but spreading that difference
// across `if (source_key === ...)` branches is how the third outlet gets half
// wired up. `hosts` is the render-time allowlist: a link only reaches the page
// if its host is one of these exactly.
interface HeadlineSourcePolicy {
	outlet: string;
	hosts: readonly string[];
	// How stale the scrape run itself may be before the outlet is dropped.
	maxScrapeAgeHours: number;
	// How old an individual article may be and still be worth linking.
	maxItemAgeHours: number;
	// Daily outlets must not re-link what the previous brief already carried.
	sincePrevBrief: boolean;
}

const HEADLINE_SOURCE_POLICY: Record<string, HeadlineSourcePolicy> = {
	"champion-news": {
		outlet: "The Champion",
		hosts: ["www.championnewspapers.com", "championnewspapers.com"],
		maxScrapeAgeHours: 8 * 24,
		maxItemAgeHours: 7 * 24,
		sincePrevBrief: false,
	},
	"dailybulletin-news": {
		outlet: "Daily Bulletin",
		hosts: ["www.dailybulletin.com", "dailybulletin.com"],
		maxScrapeAgeHours: 26,
		maxItemAgeHours: 48,
		sincePrevBrief: true,
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

export const DAILY_BRIEF_PREREQUISITE_SOURCES = [
	// 6 Frequent Sources (05:17 PT group)
	"nws-forecast",
	"nws-alerts",
	"sbcfire-news",
	"cvfd-news",
	"chino-news-rss",
	"chinohills-news-rss",
	// 9 Daily Sources (05:40 PT group)
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
		return `${day.charAt(0).toUpperCase()}${day.slice(1)} today, high ${highs}; ${night} overnight, ${lowLabel} ${lows}. ${attribution}`;
	}

	// Conditions differ, so each city has to be named with its own.
	const perCity = cities
		.map(
			(c) =>
				`**${mdEscape(c.city)}**: ${mdEscape(
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
	const deduped = dedupeByKey(alertItems, (r) => r.external_id ?? r.source_url);
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
		if (row.source_key === "sbcfire-news") {
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
		.replace(/[^\w\s]/g, " ")
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

export function selectHeadlinesElsewhere(
	headlineItems: ItemRow[] | undefined,
	freshness: Record<string, SourceFreshness> | undefined,
	now: Date,
	prevBriefPublishedAt?: string | null,
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

	// 3. Policy & relevance filter
	const eligiblePolicy = inWindow.filter(
		(item) => filterHeadlineEligibility(item).eligible,
	);

	// 4. Cross-outlet deduplication. Precedence: the local weekly's own reporting
	// wins over the regional daily's version of the same story, then the earlier
	// filing, then the lower id so runs are reproducible.
	const sortedForDedup = [...eligiblePolicy].sort((a, b) => {
		const localFirst =
			Number(b.source_key === "champion-news") -
			Number(a.source_key === "champion-news");
		if (localFirst !== 0) return localFirst;
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

	// 5. Final ordering & capping. Deterministic: occurred_at DESC, title ASC,
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

	for (const item of finalSorted) {
		if (result.length >= MAX_HEADLINES_TOTAL) break;
		const count = countByOutlet[item.source_key] ?? 0;
		if (count >= MAX_HEADLINES_PER_OUTLET) continue;

		countByOutlet[item.source_key] = count + 1;
		result.push(item);
	}

	return result;
}

/**
 * Renders the selected headlines as <li> markup and collects the URLs that go
 * into frontmatter `attributions`. A link whose host is not the outlet's own is
 * dropped rather than rendered: `selectHeadlinesElsewhere` trusts the scraper's
 * stored source_url, and this is the last place to catch a redirect or a bad
 * row before it reaches a reader.
 */
function renderHeadlineListItems(
	headlines: ItemRow[],
	notes: string[],
): { listItems: string[]; attributions: string[] } {
	const listItems: string[] = [];
	const attributions: string[] = [];

	for (const h of headlines) {
		const policy = HEADLINE_SOURCE_POLICY[h.source_key];
		let url: URL;
		try {
			url = new URL(h.source_url);
		} catch {
			notes.push(`headlines: unparseable URL skipped: ${h.source_url}`);
			continue;
		}
		if (url.protocol !== "https:" || !policy?.hosts.includes(url.hostname)) {
			notes.push(`headlines: off-allowlist URL skipped: ${h.source_url}`);
			continue;
		}

		attributions.push(h.source_url);

		const outlet = metaString(parseMeta(h.meta), "outlet") ?? policy.outlet;
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
	publishedPosts: PostRow[];
	// published_at of the previous daily brief; null on the first ever run,
	// which falls back to a 24h window for "new on the record".
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
		alertLines.push(
			`**Active alert:** ${mdLink((alert.title ?? "").trim(), cite(alert.source_url))}`,
			"",
		);
	}
	notes.push(
		`weather: ${weather.length} city forecast(s), ${activeAlerts.length} active alert(s)${weatherLine ? "" : " (condensed line unavailable; used full text)"}`,
	);

	// Fire & safety: verbatim title + source link only — never body text.
	const fire = selectFireSafety(inputs.fire, now);
	if (fire.length > 0) {
		fireLines.push("## Fire & safety", "");
		for (const row of fire) {
			const label = FIRE_LABEL[row.source_key] ?? row.source_key;
			fireLines.push(
				`- ${mdLink((row.title ?? "").trim(), cite(row.source_url))} (${label})`,
			);
		}
		fireLines.push("");
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
	if (meetings.length > 0 || events.length > 0 || marketDay) {
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
		todayLines.push("");
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
	const newPosts = selectNewRecordPosts(inputs.publishedPosts, sinceIso);
	const licenses = selectFreshLicenseEvents(inputs.licenseEvents, now);
	if (newPosts.length > 0 || licenses.length > 0) {
		recordLines.push("## New on the record", "");
		for (const p of newPosts) {
			recordLines.push(`- [${mdEscape(titleFor(p))}](/posts/${p.slug}/)`);
		}
		for (const row of licenses) {
			recordLines.push(
				`- ${mdLink((row.title ?? "").trim(), cite(row.source_url))}`,
			);
		}
		recordLines.push("");
	}
	notes.push(
		`new on the record: ${newPosts.length} post(s) since ${sinceIso}, ${licenses.length} license event(s)`,
	);

	// In the local press: secondary community press reporting (The Champion,
	// Daily Bulletin). URLs join frontmatter attributions[], NEVER sources[].
	const headlines = selectHeadlinesElsewhere(
		inputs.headlines,
		inputs.headlinesFreshness,
		now,
		inputs.prevBriefPublishedAt,
	);
	const { listItems, attributions } = renderHeadlineListItems(headlines, notes);

	if (listItems.length > 0) {
		// The heading is markdown like every other section's, so it inherits the
		// same .prose h2 treatment; only the list needs raw HTML, for the anchor
		// attributes markdown links cannot carry.
		pressLines.push(
			"## In the local press",
			"",
			'<ul class="headlines-elsewhere">',
			...listItems,
			"</ul>",
			"",
		);
	}
	notes.push(`headlines elsewhere: ${listItems.length} headline(s) selected`);

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
		listItems.length === 0
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
		fire: queryItems(db, {
			sourceKeys: FIRE_SOURCES,
			itemTypes: ["news_release", "alert"],
		}),
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
		publishedPosts: db.raw
			.prepare("SELECT * FROM posts WHERE status = 'published'")
			.all() as unknown as PostRow[],
		prevBriefPublishedAt: prev?.published_at ?? null,
	};
	return assembleBrief(inputs, now, postTitleFromFile);
}

export interface PrereqCheckResult {
	fresh: boolean;
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

	return {
		fresh: staleSources.length === 0,
		staleSources,
	};
}

function main(): void {
	const db = openDb();
	const now = new Date();

	if (process.argv.includes("--check-prereqs")) {
		const check = assertPrerequisitesFresh(db, now);
		if (!check.fresh) {
			console.error(
				`Prerequisite freshness check FAILED (${check.staleSources.length} source(s) not fresh):`,
			);
			for (const s of check.staleSources) {
				console.error(`  - ${s.sourceKey}: ${s.reason}`);
			}
			process.exitCode = 1;
			return;
		}
		console.log(
			`Prerequisite freshness check OK: all ${DAILY_BRIEF_PREREQUISITE_SOURCES.length} sources fresh for ${laDateOf(now.toISOString())}.`,
		);
		return;
	}

	console.log(`Daily brief run started at ${now.toISOString()}`);
	const prereqs = assertPrerequisitesFresh(db, now);
	if (!prereqs.fresh) {
		console.warn(
			`  warning: prerequisites not fresh (${prereqs.staleSources.length} stale source(s)):`,
		);
		for (const s of prereqs.staleSources) {
			console.warn(`    - ${s.sourceKey}: ${s.reason}`);
		}
	}

	const { post, notes } = buildDailyBrief(db, now);
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
