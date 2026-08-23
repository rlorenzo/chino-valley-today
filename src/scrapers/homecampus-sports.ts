// Phase 4 Task 4.8 — high school scores and schedules, Home Campus platform.
//
// Three of the four CVUSD high schools run their athletics sites on Home
// Campus, so one core serves all three: Chino High (103), Ayala (28) and
// Don Lugo (143). Chino Hills (104) has no Home Campus site and is handled
// separately.
//
// `POST /wp-json/sports/v1/main-teams` returns structured schedule and score
// rows. Verified live with plain curl — no cookie, nonce or session — on
// 2026-08-19 and again on 2026-08-23. robots.txt on all three sites carries
// the standard WordPress disallows and does NOT disallow /wp-json/.
//
// CITATION: responses carry `x-robots-tag: noindex`. That is an indexing
// directive rather than an access prohibition, so fetching is mechanically
// compliant — but a reader must never be pointed at the API. Every item cites
// the school's own human-readable schedule page, resolved per sport below.
//
// EDITORIAL: team-level only, per the interim rule in EDITORIAL.md standing in
// for the unresolved student-athlete naming decision. The API carries no
// player names in the fields read here, and `result_remark` is deliberately
// NOT ingested: it is free text, and free text about a high school game is
// exactly where a minor's name would appear.
import * as cheerio from "cheerio";
import { errorMessage } from "../utils/errors.ts";
import type { NewItemInput, ScraperContext, ScraperDef } from "./types.ts";

export interface HomeCampusSchool {
	/** Registry key; also the source key in the ToS registry. */
	key: string;
	/** Scraper display name. */
	name: string;
	/** Platform-global school id, shared with the CIF-SS widget's id space. */
	schoolId: number;
	/** Host serving this school's Home Campus site. */
	host: string;
	/** Display name as it should read in a citation or a roundup. */
	label: string;
}

/**
 * The per-school scraper. A factory rather than three hand-written defs: the
 * host appears in the base URL, the fetch allow-list and the API calls, and
 * three copies of that wiring is three chances for one of them to drift.
 */
export function homeCampusScraper(school: HomeCampusSchool): ScraperDef {
	return {
		key: school.key,
		name: school.name,
		baseUrl: `https://${school.host}`,
		method: "api",
		fetchDefaults: { allowedHosts: [school.host] },
		run: (ctx) => runHomeCampusSports(ctx, school),
	};
}

/** How far back results are collected, and how far ahead schedules. */
const LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 21;

/**
 * One request per school. `per_page: 100` with a bounded date window returns
 * the whole window in a single response — the default of 20 paginated a single
 * school's season across 17 pages, which is a lot of requests for a volunteer
 * host to serve us.
 */
const PER_PAGE = 100;

interface ScheduleRow {
	id?: number;
	date?: string;
	formatted_time?: string;
	sport?: string;
	sport_id?: number;
	level?: string;
	school?: string;
	school_id?: number;
	opponent?: string;
	event_type?: string;
	game_type?: string;
	location?: string;
	facility_name?: string;
	result?: string;
	score?: string;
	opponent_score?: string;
}

/**
 * The window is a school calendar, so it is anchored to the school's own
 * timezone: `toISOString()` would roll the window a day forward every evening
 * west of UTC, and roll the season year over on the afternoon of June 30.
 */
const LA_TZ = "America/Los_Angeles";
const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", {
	timeZone: LA_TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/** Pacific calendar date as YYYY-MM-DD — the format en-CA already produces. */
function pacificDay(d: Date): string {
	return PACIFIC_DAY.format(d);
}

/**
 * Shifts a YYYY-MM-DD calendar date by whole days.
 *
 * Done on the date rather than on the instant: adding 14 x 86_400_000 ms to a
 * November evening lands an hour past midnight on the far side of the DST
 * change, which moves the window's edge a day.
 */
function shiftDay(day: string, days: number): string {
	const shifted = new Date(`${day}T00:00:00Z`);
	shifted.setUTCDate(shifted.getUTCDate() + days);
	return shifted.toISOString().slice(0, 10);
}

/** The schedule index, the citation of last resort when no sport page matches. */
function scheduleIndex(host: string): string {
	return `https://${host}/schedule/`;
}

/**
 * The school's own schedule pages, as `<sport-slug> -> absolute URL`.
 *
 * Scraped rather than derived because derivation does not survive contact:
 * "Football (11 person)" is served at /varsity/football/, and
 * "Swimming & Diving, Boys" at /varsity/swimming-diving-boys-3/ — a trailing
 * disambiguator no rule would predict. The nav is the only place the real
 * slugs exist.
 */
export function parseSportSlugs(
	html: string,
	host: string,
): Map<string, string> {
	const out = new Map<string, string>();
	const $ = cheerio.load(html);
	for (const el of $("a[href]")) {
		const href = $(el).attr("href") ?? "";
		const m = /\/varsity\/([a-z0-9-]+)\/schedule-results\/?$/.exec(href);
		if (m) out.set(m[1], `https://${host}/varsity/${m[1]}/schedule-results`);
	}
	return out;
}

/** "Water Polo, Boys" -> "water-polo-boys"; "Football (11 person)" -> "football". */
export function sportSlugCandidate(sport: string): string {
	return sport
		.toLowerCase()
		.replace(/\([^)]*\)/g, " ") // "(11 person)" is a variant, not part of the name
		.replace(/&/g, " ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * The deepest citable page for a sport, or the schedule index when the nav
 * offers nothing that matches.
 *
 * Falls back rather than guessing: a constructed URL that 404s is a broken
 * citation, and a citation a reader cannot follow is worse than a shallower
 * one they can.
 */
export function citationFor(
	sport: string,
	slugs: Map<string, string>,
	host: string,
): string {
	const index = scheduleIndex(host);
	const candidate = sportSlugCandidate(sport);
	if (!candidate) return index;
	const exact = slugs.get(candidate);
	if (exact) return exact;
	// "swimming-diving-boys" -> "swimming-diving-boys-3". Only a numeric
	// disambiguator counts: without that bound, "golf-boys" would match
	// "golf-boys-and-girls", a different team.
	for (const [slug, url] of slugs) {
		const suffix = slug.startsWith(`${candidate}-`)
			? slug.slice(candidate.length + 1)
			: "";
		if (suffix && /^\d+$/.test(suffix)) return url;
	}
	return index;
}

/**
 * A game counts as played only with all three of score, opponent score and
 * result. A partial score is the source mid-update, not a result — and the run
 * note counts with this same predicate, so a diagnostic can never report a row
 * as played that was stored as unplayed.
 */
export function isPlayed(row: ScheduleRow): boolean {
	return Boolean(
		(row.score ?? "").trim() &&
			(row.opponent_score ?? "").trim() &&
			(row.result ?? "").trim(),
	);
}

/** Title lines are deterministic and team-level: no player is ever named. */
export function titleFor(row: ScheduleRow): string | null {
	const sport = (row.sport ?? "").trim();
	const school = (row.school ?? "").trim();
	const opponent = (row.opponent ?? "").trim();
	if (!sport || !school || !opponent) return null;
	const level = (row.level ?? "").trim();
	const prefix = level ? `${level} ${sport}` : sport;

	const score = (row.score ?? "").trim();
	const oppScore = (row.opponent_score ?? "").trim();
	const result = (row.result ?? "").trim().toUpperCase();
	if (score && oppScore && result) {
		const verb = result === "W" ? "def." : result === "L" ? "lost to" : "vs";
		return result === "L"
			? `${prefix}: ${school} ${verb} ${opponent}, ${oppScore}-${score}`
			: `${prefix}: ${school} ${verb} ${opponent}, ${score}-${oppScore}`;
	}
	const home = (row.location ?? "").trim().toLowerCase() === "home";
	return `${prefix}: ${school} ${home ? "vs" : "at"} ${opponent}`;
}

export function rowToItem(
	row: ScheduleRow,
	documentId: number,
	sourceUrl: string,
): NewItemInput | null {
	// The platform id is the only stable identity here. `event_identifier`
	// encodes the date, so a rescheduled game would arrive as a new item and
	// the old date would linger; keyed on id, a reschedule updates in place.
	// The same reasoning picks ONE item_type for played and unplayed games:
	// a game that gains its score must update its row, not open a second one.
	if (typeof row.id !== "number") return null;
	const title = titleFor(row);
	if (!title) return null;
	const date = (row.date ?? "").trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

	const score = (row.score ?? "").trim();
	const oppScore = (row.opponent_score ?? "").trim();
	const result = (row.result ?? "").trim().toUpperCase();
	const played = isPlayed(row);

	return {
		document_id: documentId,
		source_url: sourceUrl,
		item_type: "game",
		external_id: String(row.id),
		title,
		body: null,
		// A bare local date, not an instant: the API gives a school-day date and
		// a wall-clock time with no zone, and inventing one would be a guess.
		// See PLAN.md on occurred_at carrying both meanings by source.
		occurred_at: date,
		meta: {
			sport: (row.sport ?? "").trim(),
			sportId: row.sport_id ?? null,
			level: (row.level ?? "").trim(),
			school: (row.school ?? "").trim(),
			schoolId: row.school_id ?? null,
			opponent: (row.opponent ?? "").trim(),
			// Cross-country meets and tournaments are posted before an opponent
			// exists, as a literal "TBA". Kept for the record — it is a real
			// scheduled event — but flagged, because "Chino at TBA" tells a
			// reader nothing and a roundup should skip it.
			opponentTbd: /^tba$/i.test((row.opponent ?? "").trim()),
			eventType: (row.event_type ?? "").trim(),
			gameType: (row.game_type ?? "").trim(),
			location: (row.location ?? "").trim(),
			facility: (row.facility_name ?? "").trim() || null,
			timeLabel: (row.formatted_time ?? "").trim() || null,
			played,
			result: played ? result : null,
			score: played ? score : null,
			opponentScore: played ? oppScore : null,
		},
	};
}

export async function runHomeCampusSports(
	ctx: ScraperContext,
	school: HomeCampusSchool,
	now: Date = new Date(),
): Promise<void> {
	const { host, schoolId, label } = school;

	// The nav carries the citable per-sport pages; fetched raw because it is a
	// lookup table, not something an item points at.
	//
	// The three outcomes are reported apart on purpose. `fetchRaw` resolves on a
	// 404 or a 503 rather than throwing, so a failed fetch and a page that
	// simply has no links both end with an empty map — and "no per-sport
	// schedule links found" would then blame the school's markup for our own
	// failed request. Every one of them still degrades the same way, to a
	// shallower but working citation.
	let slugs = new Map<string, string>();
	let navProblem: string | null = null;
	try {
		const home = await ctx.fetchRaw(`https://${host}/`, {
			allowedHosts: [host],
		});
		if (home.ok) {
			slugs = parseSportSlugs(home.body.toString("utf8"), host);
			if (slugs.size === 0) navProblem = "the nav carried no per-sport links";
		} else {
			navProblem = `the home page answered HTTP ${home.status}`;
		}
	} catch (err) {
		navProblem = `the home page could not be fetched (${errorMessage(err)})`;
	}
	if (navProblem) {
		ctx.note(
			`${label}: ${navProblem}; citing ${scheduleIndex(host)} for every sport.`,
		);
	}

	const today = pacificDay(now);
	const dateFrom = shiftDay(today, -LOOKBACK_DAYS);
	const dateTo = shiftDay(today, LOOKAHEAD_DAYS);
	// The school-year start year: 2026 means the 2026-27 season, which starts in
	// July. Read off the Pacific date so the rollover lands on the school's
	// July 1, not on UTC's.
	const startsThisYear = Number(today.slice(5, 7)) >= 7;
	const year = String(Number(today.slice(0, 4)) - (startsThisYear ? 0 : 1));

	const doc = await ctx.fetchDocument(
		`https://${host}/wp-json/sports/v1/main-teams`,
		{
			docType: "feed",
			title: `${label} schedule and results ${dateFrom}..${dateTo}`,
			// The endpoint is a query wearing POST's clothes: it filters a
			// schedule table by school and date range and changes nothing. A
			// volunteer-run WordPress host answering 503 for a moment is exactly
			// when the retry earns its keep, and replaying a read cannot
			// double-anything.
			bodyIsIdempotent: true,
			jsonBody: {
				page: 1,
				per_page: PER_PAGE,
				limit: PER_PAGE,
				order: "asc",
				cache_only: "",
				date_from: dateFrom,
				date_to: dateTo,
				school_id: String(schoolId),
				sport_id_params: "",
				year,
			},
		},
	);

	let payload: unknown;
	try {
		payload = JSON.parse(doc.body.toString("utf8"));
	} catch {
		ctx.note(`${label}: response was not JSON; nothing ingested this run.`);
		return;
	}

	const rows = schedulesFrom(payload);
	if (rows === null) {
		// The envelope is {success, data:{data:{schedules:[...]}}}. If that shape
		// ever changes, say so loudly: an empty ingest and a moved field look
		// identical from the outside, and the quiet one is the dangerous one.
		ctx.note(
			`${label}: response JSON did not contain data.data.schedules — the API shape may have changed. Nothing ingested.`,
		);
		return;
	}

	// The response is a platform-wide table filtered by request, and the loop
	// below already drops rows belonging to another school. The note counts the
	// same filtered set, so a diagnostic can never describe rows this run had no
	// intention of storing.
	const mine = rows.filter(
		(row) => row.school_id === undefined || row.school_id === schoolId,
	);

	let stored = 0;
	for (const row of mine) {
		const item = rowToItem(
			row,
			doc.documentId,
			citationFor((row.sport ?? "").trim(), slugs, host),
		);
		if (!item) continue;
		ctx.insertItem(item);
		stored++;
	}

	const played = mine.filter(isPlayed).length;
	const foreign = rows.length - mine.length;
	ctx.note(
		`${label}: ${mine.length} row(s) in ${dateFrom}..${dateTo} (${played} played, season year ${year})${
			foreign > 0 ? `, ${foreign} row(s) for other schools ignored` : ""
		} -> ${stored} item(s).`,
	);
}

/** Digs the schedule rows out of the response envelope, or null if absent. */
function schedulesFrom(payload: unknown): ScheduleRow[] | null {
	if (!payload || typeof payload !== "object") return null;
	const outer = (payload as { data?: unknown }).data;
	if (!outer || typeof outer !== "object") return null;
	const inner = (outer as { data?: unknown }).data;
	if (!inner || typeof inner !== "object") return null;
	const schedules = (inner as { schedules?: unknown }).schedules;
	return Array.isArray(schedules) ? (schedules as ScheduleRow[]) : null;
}
