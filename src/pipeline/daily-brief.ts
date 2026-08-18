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
	periods: Array<{ name: string; body: string }>;
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
			const name = metaString(parseMeta(row.meta), "periodName");
			if (!name) continue;
			periods.push({ name, body: row.body.replace(/\s+/g, " ").trim() });
		}
		const sourceUrl = (day ?? night)?.source_url;
		if (periods.length === 0 || !sourceUrl) continue;
		out.push({ city, sourceUrl, periods });
	}
	return out;
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

// The week ahead, exclusive of today (today's events live in the brief body):
// LA days (today, today + horizonDays], deduped by source_url. Rendered by
// the site from frontmatter, not by the markdown body.
export function selectUpcomingEvents(
	eventItems: ItemRow[],
	now: Date,
	horizonDays = 7,
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

// --- Assembly ----------------------------------------------------------------

export interface BriefInputs {
	forecast: ItemRow[];
	nwsAlerts: ItemRow[];
	fire: ItemRow[];
	calendarEvents: ItemRow[];
	agendaItems: ItemRow[];
	cvusdEvents: ItemRow[];
	licenseEvents: ItemRow[];
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

	const body: string[] = [];

	// Weather line (no heading — it opens the brief).
	const weather = selectWeather(inputs.forecast, now);
	for (const cityFc of weather) {
		const text = cityFc.periods
			.map((p) => `${p.name}: ${mdEscape(p.body)}`)
			.join(" ");
		body.push(
			`**${mdEscape(cityFc.city)}** — ${text} (${mdLink("NWS forecast", cite(cityFc.sourceUrl))})`,
		);
		body.push("");
	}
	const activeAlerts = selectActiveAlerts(inputs.nwsAlerts, now);
	for (const alert of activeAlerts) {
		body.push(
			`**Active alert:** ${mdLink((alert.title ?? "").trim(), cite(alert.source_url))}`,
		);
		body.push("");
	}
	notes.push(
		`weather: ${weather.length} city forecast(s), ${activeAlerts.length} active alert(s)`,
	);

	// Fire & safety: verbatim title + source link only — never body text.
	const fire = selectFireSafety(inputs.fire, now);
	if (fire.length > 0) {
		body.push("## Fire & safety", "");
		for (const row of fire) {
			const label = FIRE_LABEL[row.source_key] ?? row.source_key;
			body.push(
				`- ${mdLink((row.title ?? "").trim(), cite(row.source_url))} (${label})`,
			);
		}
		body.push("");
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
		body.push("## Today", "");
		for (const m of meetings) {
			const time = m.timeLabel ? ` — ${m.timeLabel}` : "";
			body.push(`- **Meeting:** ${mdLink(m.title, cite(m.url))}${time}`);
		}
		for (const e of events) {
			const time = e.timeLabel ? `${e.timeLabel} — ` : "";
			const venue = e.venue ? ` at ${mdEscape(e.venue)}` : "";
			body.push(`- ${time}${mdLink(e.title, cite(e.sourceUrl))}${venue}`);
		}
		if (marketDay) {
			body.push(
				`- Heritage Farmers Market, every Wednesday 3:30–7:30pm at the Shoppes (${mdLink("heritagefarmersmarket.org", cite(FARMERS_MARKET_URL))})`,
			);
		}
		body.push("");
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
	notes.push(`coming up: ${upcoming.length} event(s) in the next 7 days`);

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
		body.push("## New on the record", "");
		for (const p of newPosts) {
			body.push(`- [${mdEscape(titleFor(p))}](/posts/${p.slug}/)`);
		}
		for (const row of licenses) {
			body.push(`- ${mdLink((row.title ?? "").trim(), cite(row.source_url))}`);
		}
		body.push("");
	}
	notes.push(
		`new on the record: ${newPosts.length} post(s) since ${sinceIso}, ${licenses.length} license event(s)`,
	);

	// A quiet day ships honestly: weather + schedule, plainly labeled. The
	// label states what the morning is, not a roll call of alarming things
	// that didn't happen — the omitted sections already say the rest.
	if (fire.length === 0 && newPosts.length === 0 && licenses.length === 0) {
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
		publishedPosts: db.raw
			.prepare("SELECT * FROM posts WHERE status = 'published'")
			.all() as unknown as PostRow[],
		prevBriefPublishedAt: prev?.published_at ?? null,
	};
	return assembleBrief(inputs, now, postTitleFromFile);
}

function main(): void {
	const db = openDb();
	const now = new Date();
	console.log(`Daily brief run started at ${now.toISOString()}`);

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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
