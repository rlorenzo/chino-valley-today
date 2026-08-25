// Phase 4 Task 4.8 — Chino Hills High School athletics, via the CIF-SS widget.
//
// Chino Hills (school id 104) is the one CVUSD high school with no Home Campus
// site, so it cannot ride homecampus-sports.ts. CIF-SS publishes the same data
// through the schedule-score widget that cifss.org itself embeds: server
// rendered, plain GET, no session, and robots.txt is fully open with no
// Crawl-delay (`User-agent: *` / `Disallow:`).
//
// ONE REQUEST PER SPORT. The widget requires a sport_id — leaving it blank
// returns nothing — so a full sweep is 36 requests, most of them answering with
// an empty table because the sport is out of season. That is deliberate. The
// alternative considered was inferring which sports are in season from the
// three Home Campus schools we already scrape, cutting it to about six
// requests; it was rejected because when the inference is wrong it under-covers
// Chino Hills silently, and quiet under-coverage is the failure this project
// keeps paying for. CIF-SS is a section governing body's own infrastructure,
// not a volunteer host, and an empty table is cheap for them to serve.
//
// The sport list is read from the widget's own <select> rather than hardcoded,
// so a sport added or renamed mid-season is picked up without a code change.
//
// EDITORIAL: team-level only, per EDITORIAL.md's interim rule. The Notes column
// is free text and is NOT ingested, for the same reason result_remark is left
// out of the Home Campus rows: free text about a high school game is where a
// minor's name appears.
import * as cheerio from "cheerio";
import { type GameResult, outcomeClause } from "./game-title.ts";
import { readableSchoolName } from "./school-name.ts";
import { pacificDay, schoolYearStart } from "./school-year.ts";
import type { NewItemInput, ScraperContext, ScraperDef } from "./types.ts";

const HOST = "www.cifsshome.org";
const SCHOOL_ID = 104;
/** Southern Section. */
const SECTION_ID = 1;
/** How the school's own name appears in the widget's Home/Away columns. */
const SCHOOL_NAME = "Chino Hills";
/**
 * The sport asked for first, purely so the response carries the widget's own
 * sport <select> and the list costs no extra request. Its name is spelled out
 * only to title the archived document; if CIF-SS ever renumbers, that one label
 * goes stale and nothing else does, because every other sport is read from the
 * <select>.
 */
const PROBE_SPORT: WidgetSport = { id: "1", name: "Football (11 person)" };

export interface WidgetSport {
	id: string;
	name: string;
}

export function widgetUrl(sportId: string, year: string): string {
	return (
		`https://${HOST}/widget/schedule-score?section_id=${SECTION_ID}` +
		`&year=${year}&sport_id=${sportId}&school_id=${SCHOOL_ID}` +
		"&date_from=&date_to=&game_type_id="
	);
}

/** The sport options the widget itself offers, in the order it lists them. */
export function parseSports(htmlText: string): WidgetSport[] {
	const $ = cheerio.load(htmlText);
	const out: WidgetSport[] = [];
	$('select[name="sport_id"] option').each((_i, el) => {
		const id = ($(el).attr("value") ?? "").trim();
		const name = $(el).text().trim();
		// The placeholder option carries an empty value, which the widget
		// rejects anyway.
		if (id && name) out.push({ id, name });
	});
	return out;
}

export interface WidgetRow {
	eventId: string;
	sport: string;
	home: string;
	away: string;
	homeScore: string;
	awayScore: string;
	/** MM/DD/YYYY as the widget prints it. */
	date: string;
	time: string;
	gameType: string;
	facility: string;
}

/** `MM/DD/YYYY` -> `YYYY-MM-DD`, or null if it is not a date. */
export function isoDate(printed: string): string | null {
	const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(printed.trim());
	return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * The widget's fixture rows, read positionally.
 *
 * Its 12 columns are, in order: Sport, Home, Facility, Home Division, Home
 * Score, Away, Away Division, Away Score, Date, Time, Game Type, Notes. There
 * are no headers, classes or data attributes to key on, so position is all the
 * markup offers; a row with fewer cells than that is not a fixture and is
 * dropped rather than read against the wrong columns.
 */
/**
 * The columns we read, by the header the widget prints above them.
 *
 * Read by NAME rather than by position. The table is twelve columns wide today
 * and the last one is Notes -- free text, deliberately never ingested -- but a
 * fixed index only holds while the column count does. Drop or reorder one
 * upstream and every index after it shifts, which would quietly slide Notes
 * into gameType: the free text landing in a stored field precisely because the
 * rule against it was enforced by counting rather than by naming.
 *
 * Reading by name also means a column we do not name cannot be read by
 * accident, whatever the widget does to the layout.
 */
const COLUMNS = {
	sport: "Sport",
	home: "Home",
	homeScore: "Home Score",
	away: "Away",
	awayScore: "Away Score",
	date: "Date",
	facility: "Facility",
	time: "Time",
	gameType: "Game Type",
} as const;

type ColumnKey = keyof typeof COLUMNS;

/**
 * The columns without which a row says nothing: who played whom, when, and
 * what the score was. If one of these has gone, the widget's shape has changed
 * enough that parsing should stop rather than guess.
 *
 * Facility, Time and Game Type are context. Losing one costs a meta field and
 * nothing else, so it must not cost the fixture as well.
 */
const REQUIRED: readonly ColumnKey[] = [
	"sport",
	"home",
	"homeScore",
	"away",
	"awayScore",
	"date",
];

/** Header text -> column index, from the widget's own thead. */
export function headerIndex(htmlText: string): Map<string, number> {
	const $ = cheerio.load(htmlText);
	const index = new Map<string, number>();
	$("table th").each((i, el) => {
		const label = $(el).text().replace(/\s+/g, " ").trim();
		if (label && !index.has(label)) index.set(label, i);
	});
	return index;
}

/**
 * Where each column we read currently sits. Null when a REQUIRED one is
 * absent; an optional one that is absent is simply omitted, and reads as "".
 */
export function resolveColumns(
	htmlText: string,
): Partial<Record<ColumnKey, number>> | null {
	const headers = headerIndex(htmlText);
	const resolved: Partial<Record<ColumnKey, number>> = {};
	for (const [key, label] of Object.entries(COLUMNS) as [ColumnKey, string][]) {
		const at = headers.get(label);
		if (at !== undefined) resolved[key] = at;
	}
	return REQUIRED.every((key) => resolved[key] !== undefined) ? resolved : null;
}

export function parseRows(htmlText: string): WidgetRow[] {
	const columns = resolveColumns(htmlText);
	if (!columns) return [];
	const $ = cheerio.load(htmlText);
	const rows: WidgetRow[] = [];
	$("tbody tr").each((_i, el) => {
		const eventId = ($(el).attr("id") ?? "").trim();
		// The row id is the platform's own event id and the only stable identity
		// the widget offers. Without one there is nothing to key on, so the row
		// is dropped rather than given a derived id that would churn.
		if (!/^\d+$/.test(eventId)) return;
		const cells = $(el)
			.find("td")
			.map((_j, td) => $(td).text().replace(/\s+/g, " ").trim())
			.get();
		const at = (key: ColumnKey): string => {
			const i = columns[key];
			return i === undefined ? "" : (cells[i] ?? "");
		};
		// A row too narrow to carry the columns a fixture needs is malformed.
		const widest = Math.max(...REQUIRED.map((k) => columns[k] as number));
		if (cells.length <= widest) return;
		rows.push({
			eventId,
			sport: at("sport"),
			home: at("home"),
			facility: at("facility"),
			homeScore: at("homeScore"),
			away: at("away"),
			awayScore: at("awayScore"),
			date: at("date"),
			time: at("time"),
			gameType: at("gameType"),
		});
	});
	return rows;
}

/**
 * Which side of the row is us.
 *
 * The widget names both teams rather than framing the row around the school
 * queried, so "Chino Hills" has to be located. Matched exactly: a substring
 * test would also match "Chino Hills Christian", a different school, and would
 * then report their result as ours.
 */
export function chinoHillsSide(row: WidgetRow): "home" | "away" | null {
	const exact = (side: string) =>
		side.trim().toLowerCase() === SCHOOL_NAME.toLowerCase();
	if (exact(row.home)) return "home";
	if (exact(row.away)) return "away";
	return null;
}

/**
 * The outcome from our side, or null when the row is not a played result.
 *
 * Both scores have to be present and numeric. One alone is the section
 * mid-entry, and a non-numeric cell — a forfeit letter, a dash — compares as
 * NaN, which would silently be reported as a tie.
 */
export function resultOf(
	ourScore: string,
	theirScore: string,
): GameResult | null {
	if (!/^\d+$/.test(ourScore) || !/^\d+$/.test(theirScore)) return null;
	const margin = Number(ourScore) - Number(theirScore);
	if (margin > 0) return "W";
	if (margin < 0) return "L";
	return "T";
}

export function rowToItem(
	row: WidgetRow,
	documentId: number,
	sourceUrl: string,
): NewItemInput | null {
	const side = chinoHillsSide(row);
	if (!side) return null;
	const date = isoDate(row.date);
	if (!date) return null;

	const opponent = readableSchoolName(side === "home" ? row.away : row.home);
	if (!opponent) return null;
	const ourScore = (side === "home" ? row.homeScore : row.awayScore).trim();
	const theirScore = (side === "home" ? row.awayScore : row.homeScore).trim();
	const result = resultOf(ourScore, theirScore);
	const played = result !== null;

	const sport = row.sport.trim();
	// No level here: unlike Home Campus, the widget does not say varsity or JV.
	const title = `${sport}: ${outcomeClause({
		school: SCHOOL_NAME,
		opponent,
		result,
		score: ourScore,
		opponentScore: theirScore,
		home: side === "home",
	})}`;

	return {
		document_id: documentId,
		source_url: sourceUrl,
		// The same item_type the Home Campus schools use, so a roundup reads one
		// shape for all four schools.
		item_type: "game",
		external_id: row.eventId,
		title,
		body: null,
		// A bare local date: the widget prints a calendar day and a wall-clock
		// time with no zone, and inventing an instant would be a guess.
		occurred_at: date,
		meta: {
			sport,
			school: SCHOOL_NAME,
			schoolId: SCHOOL_ID,
			opponent,
			location: side === "home" ? "Home" : "Away",
			facility: row.facility || null,
			timeLabel: row.time || null,
			gameType: row.gameType || null,
			played,
			result,
			score: played ? ourScore : null,
			opponentScore: played ? theirScore : null,
			opponentTbd: /^tba$/i.test(opponent),
		},
	};
}

/**
 * Blanks the Laravel CSRF token the widget mints per request.
 *
 * It is the only byte that differs between two fetches of an unchanged page —
 * verified by diffing them — and without this every sport's response hashes
 * differently on every run, minting 36 document rows and 36 raw-archive files a
 * day for pages that have not changed. A token says nothing about a fixture, so
 * nothing is lost by not archiving it.
 */
export function stripCsrfToken(body: Buffer): Buffer {
	return Buffer.from(
		body
			.toString("utf8")
			.replace(
				/(name="_token"\s+value=")[^"]*(")/g,
				"$1STRIPPED-BY-CHINO-VALLEY-TODAY$2",
			),
		"utf8",
	);
}

export async function runChinoHillsSports(
	ctx: ScraperContext,
	now: Date = new Date(),
): Promise<void> {
	const year = schoolYearStart(pacificDay(now));

	const probeUrl = widgetUrl(PROBE_SPORT.id, year);
	const probe = await ctx.fetchDocument(probeUrl, {
		docType: "listing",
		title: `Chino Hills athletics — ${PROBE_SPORT.name}, ${year}`,
		stripVolatile: stripCsrfToken,
	});
	const probeHtml = probe.body.toString("utf8");

	const sports = parseSports(probeHtml);
	if (sports.length === 0) {
		// The sport list is the widget's own navigation, not a season's fixtures:
		// it lists all 36 sports year-round. An empty list is broken markup, and
		// a note about it would be recorded as a `success` run with 0 items —
		// exactly how chinohills-swagit hid a six-day outage.
		throw new Error(
			`Chino Hills: the widget at ${probeUrl} served no sport list — its markup has probably changed.`,
		);
	}

	let stored = 0;
	let played = 0;
	let sportsWithGames = 0;

	// A sport whose headers will not resolve parses to nothing, which is exactly
	// what an out-of-season sport looks like — and with 36 sports queried, a
	// rename upstream could empty all of them while the run still reported
	// success. Counted and named separately so the two cannot be confused.
	let unreadable = 0;

	const ingest = (htmlText: string, documentId: number, url: string): void => {
		if (!resolveColumns(htmlText)) {
			unreadable++;
			return;
		}
		const rows = parseRows(htmlText).filter((r) => chinoHillsSide(r) !== null);
		if (rows.length > 0) sportsWithGames++;
		for (const row of rows) {
			const item = rowToItem(row, documentId, url);
			if (!item) continue;
			ctx.insertItem(item);
			stored++;
			// Read back off the stored item rather than recomputed, so the run
			// note can never describe a row differently from how it was ingested.
			if ((item.meta as { played: boolean }).played) played++;
		}
	};

	ingest(probeHtml, probe.documentId, probeUrl);

	for (const sport of sports) {
		if (sport.id === PROBE_SPORT.id) continue; // answered by the probe, above
		const url = widgetUrl(sport.id, year);
		const doc = await ctx.fetchDocument(url, {
			docType: "listing",
			title: `Chino Hills athletics — ${sport.name}, ${year}`,
			stripVolatile: stripCsrfToken,
		});
		ingest(doc.body.toString("utf8"), doc.documentId, url);
	}

	if (unreadable > 0) {
		ctx.note(
			`Chino Hills: ${unreadable} of ${sports.length} sport(s) returned a table whose headers could not be resolved — the widget's markup may have changed. Those sports ingested nothing.`,
		);
	}
	ctx.note(
		`Chino Hills: ${sports.length} sport(s) queried for ${year}, ${sportsWithGames} with games -> ${stored} item(s) (${played} played).`,
	);
}

const scraper: ScraperDef = {
	key: "chinohills-sports",
	name: "Chino Hills High School Athletics (CIF-SS widget)",
	baseUrl: `https://${HOST}`,
	method: "html",
	fetchDefaults: { allowedHosts: [HOST] },
	run: (ctx) => runChinoHillsSports(ctx),
};

export default scraper;
