// Chino Community Theatre — season page (announced show run dates).
//
// The theatre's own domain, chinocommunitytheatre.org, 301-redirects into a
// Google Sites site: https://sites.google.com/view/chinocommunitytheatre/2026-season
// (verified live 2026-09-04; the `?authuser=0` query param Google appends is
// droppable). Google Sites is not WordPress and exposes no API, RSS, or
// iCal — the server-rendered season page is the only machine-readable
// surface. robots.txt (sites.google.com/robots.txt, fetched 2026-09-04)
// disallows /feeds and any path containing /_/ (with narrow Allow exceptions
// for /*/_/rsrc/ and /_/atari/*); the season page path has none of that, so
// fetching it is permitted.
//
// Markup shape: each show is a run of <p> paragraphs — a title paragraph,
// author/director paragraphs, one or more synopsis paragraphs, then one or
// two bold date-list paragraphs ("January 16, 17, 23, 24, 30, 31 at 7:30pm").
// Google Sites' class names (zfr3Q, CDt4Ke, C9DxTc, Rn3Z1b, ...) are
// auto-generated hashes that change on every edit, so nothing here selects on
// them. Two things ARE anchored on, deliberately:
//   - Show titles are identified by an inline-style fingerprint (a <span>
//     that is both italic and font-weight:700) whose OWN text is fully
//     upper-case — not by the surrounding class, and not by "the whole
//     paragraph is upper-case" (see below for why that weaker rule fails).
//   - Performance dates are identified by a text pattern: a date list
//     followed by "at"/"@" and a time, anywhere on the page.
// Every date-list paragraph found is attributed to the most recently seen
// title span, in document order.
//
// Why "whole paragraph is upper-case" is NOT enough (discovered fetching the
// live page, not assumed): POTUS's title paragraph is actually
// "POTUS: or Behind Every Great Dumbass Are Seven Women Trying to Keep Him
// Alive" — mixed case once the subtitle is included, even though the "POTUS"
// span itself is upper-case. And a plain "AUDIENCE ADVISORY:" paragraph
// (bold, but NOT italic) sits between The Full Monty's synopsis and its date
// lines; a whole-paragraph upper-case rule would wrongly treat it as a new
// show and swallow Full Monty's dates. Requiring italic+bold on the specific
// span, and checking only THAT span's text for upper-case, survives both.
//
// A further wrinkle, also only visible in the real markup: "Theatre on the
// Edge" is a two-one-act festival, and the two one-acts (Dead Man's Cell
// Phone, POTUS) each carry their OWN date-list paragraphs; the "Theatre on
// the Edge" banner title itself has no date list of its own and therefore
// produces no items. That is correct, not a bug — a reader asking "when is
// Dead Man's Cell Phone" sees dates attached to that title, not the banner.
//
// Year handling: date lines never carry a year. This scraper reads the page
// `<title>` ("Chino Community Theatre - 2026 Season") and applies that one
// year to every performance on the page. This is a real assumption, not a
// given: it fails as soon as a season page lists dates spanning a calendar
// year boundary (this one doesn't — all six shows fall within Jan-Dec 2026)
// or the theatre reuses this URL for a future season without updating the
// title. Both failure modes are silent — a wrong year, not a thrown error —
// so this is the single most fragile part of the scraper; see run()'s
// zero-year guard, which at least catches the title format itself moving.

import * as cheerio from "cheerio";
import { localDateTimeToIso } from "./civicplus-rss.ts";
import { resolveDocumentId } from "./document-linkage.ts";
import { idSlug } from "./external-id.ts";
import type { NewItemInput, ScraperDef } from "./types.ts";

const HOST = "https://sites.google.com";
const SEASON_URL = `${HOST}/view/chinocommunitytheatre/2026-season`;

const FULL_MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

// Abbreviated/full month name (with or without a trailing period) -> full
// name, so "Sept", "Sep" and "September" all resolve. Needed because
// localDateTimeToIso only recognizes full month names. Any prefix of three or
// more letters is accepted, which covers every abbreviation the page uses
// without a table of them; two letters or fewer is ambiguous ("ma", "ju") and
// is rejected rather than guessed at.
function normalizeMonth(raw: string): string | null {
	const prefix = raw.replace(/\.$/, "").toLowerCase();
	if (prefix.length < 3) return null;
	return FULL_MONTHS.find((m) => m.toLowerCase().startsWith(prefix)) ?? null;
}

// "7:30pm", "7:30 pm", "2:30 p.m." -> "7:30 PM" (the shape localDateTimeToIso
// expects). Returns null rather than guessing when nothing matches.
function normalizeTime(raw: string): string | null {
	const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i);
	if (!m) return null;
	return `${m[1]}:${m[2] ?? "00"} ${m[3].toUpperCase()}M`;
}

// "7:30 PM" -> "1930", for a stable id component independent of the source's
// inconsistent time punctuation.
function militaryTime(timeText: string): string {
	const m = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
	if (!m) return "0000";
	let hour = parseInt(m[1], 10) % 12;
	if (/pm/i.test(m[3])) hour += 12;
	return `${String(hour).padStart(2, "0")}${m[2]}`;
}

function isAllCapsText(text: string): boolean {
	const letters = text.replace(/[^A-Za-z]/g, "");
	return letters.length >= 2 && letters === letters.toUpperCase();
}

export interface TheatrePerformance {
	title: string;
	year: number;
	month: string; // full name, e.g. "January"
	day: number;
	timeText: string; // "7:30 PM"
}

// One "at"/"@"-delimited clause, e.g. "January 16, 17, 23, 24, 30, 31 at
// 7:30pm". A single date-list paragraph can hold two such clauses joined by
// ";" (POTUS's page does this) — parsePerformances splits on ";" before
// calling this, so a clause here never contains one itself.
const CLAUSE_RE =
	/^(.+?)\s*(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\.?\s*$/i;

// A comma-separated date token: an optional month name carries forward to
// later bare-day tokens in the same clause ("Sept 18, 19" -> both September;
// "Sept 18, ... Oct 2" -> the month switches mid-clause for a season that
// crosses a month boundary).
const TOKEN_RE = /^(?:([A-Za-z]+)\.?\s+)?(\d{1,2})$/;

function parseDateClause(
	clause: string,
): { month: string; day: number; timeText: string }[] | null {
	const m = clause.match(CLAUSE_RE);
	if (!m) return null;
	const timeText = normalizeTime(m[2]);
	if (!timeText) return null;

	let month: string | null = null;
	const out: { month: string; day: number; timeText: string }[] = [];
	for (const rawToken of m[1].split(",")) {
		const tok = rawToken.trim();
		if (!tok) continue;
		const tm = tok.match(TOKEN_RE);
		if (!tm) return null; // an unrecognized token means this isn't a date list after all
		if (tm[1]) {
			const normalized = normalizeMonth(tm[1]);
			if (!normalized) return null;
			month = normalized;
		}
		if (!month) return null; // first token must carry a month
		out.push({ month, day: parseInt(tm[2], 10), timeText });
	}
	return out.length ? out : null;
}

// Reads the "<year> Season" marker from the page <title>. Returns null
// rather than guessing when it's not there — see the year-handling note at
// the top of this file for what that failure mode means in practice.
export function parseSeasonYear(html: string): number | null {
	const $ = cheerio.load(html);
	const m = $("title")
		.first()
		.text()
		.match(/(\d{4})\s*Season/i);
	return m ? parseInt(m[1], 10) : null;
}

// Pure parse over the season page HTML, exported for tests.
export function parsePerformances(
	html: string,
	seasonYear: number,
): TheatrePerformance[] {
	const $ = cheerio.load(html);
	const out: TheatrePerformance[] = [];
	let currentTitle: string | null = null;

	$("p").each((_, p) => {
		const el = $(p);

		// A title paragraph carries a span that is BOTH italic and bold, whose
		// own text (not the whole paragraph's) is fully upper-case. See the
		// header comment for the two real cases ("AUDIENCE ADVISORY:", and
		// POTUS's mixed-case subtitle) this specifically avoids.
		let titleSpan: string | null = null;
		el.find("span").each((_, s) => {
			if (titleSpan) return;
			const style = $(s).attr("style") ?? "";
			if (!/italic/i.test(style) || !/font-weight:\s*700/.test(style)) return;
			const text = $(s).text().replace(/\s+/g, " ").trim();
			if (text && isAllCapsText(text)) titleSpan = text;
		});
		if (titleSpan) {
			currentTitle = titleSpan;
			return;
		}
		if (!currentTitle) return;

		const text = el.text().replace(/\s+/g, " ").trim();
		if (!text) return;
		for (const rawClause of text.split(";")) {
			const parsed = parseDateClause(rawClause.trim());
			if (!parsed) continue;
			for (const { month, day, timeText } of parsed) {
				out.push({
					title: currentTitle,
					year: seasonYear,
					month,
					day,
					timeText,
				});
			}
		}
	});

	return out;
}

export function performanceToItem(
	p: TheatrePerformance,
): Omit<NewItemInput, "document_id"> | null {
	const occurredAt = localDateTimeToIso(
		`${p.month} ${p.day}, ${p.year}`,
		p.timeText,
	);
	if (!occurredAt) return null;
	const monthNum = FULL_MONTHS.indexOf(p.month) + 1;
	const isoDate = `${p.year}-${String(monthNum).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
	// Date + time, not just date: several shows run an evening AND a matinee
	// on the same calendar date (Ghost Train's Jan 24 and Jan 31), so the date
	// alone is not a unique performance.
	return {
		source_url: SEASON_URL,
		item_type: "event",
		external_id: `${isoDate}-${militaryTime(p.timeText)}-${idSlug(p.title).slice(0, 60)}`,
		title: p.title,
		body: null,
		occurred_at: occurredAt,
		meta: {
			host: "chinocommunitytheatre.org",
			venue: "Chino Community Theatre",
			allDay: false,
			showTitle: p.title,
		},
	};
}

const scraper: ScraperDef = {
	key: "chinotheatre-events",
	name: "Chino Community Theatre (season page)",
	baseUrl: HOST,
	method: "html",
	async run(ctx) {
		const doc = await ctx.fetchDocument(SEASON_URL, {
			docType: "listing",
			title: "Chino Community Theatre — Season",
		});
		const html = doc.body.toString("utf8");

		const seasonYear = parseSeasonYear(html);
		if (seasonYear === null) {
			throw new Error(
				`Could not find a "<year> Season" marker in ${SEASON_URL}'s <title> — ` +
					"the year-detection this scraper depends on has broken, and dates cannot " +
					"be safely resolved without silently guessing a year.",
			);
		}

		const performances = parsePerformances(html, seasonYear);
		if (performances.length === 0) {
			throw new Error(
				`No performances parsed from ${SEASON_URL} — expected several bold, italic, ` +
					'all-caps show titles each followed by a bold date-list paragraph ("January ' +
					'16, 17 ... at 7:30pm" or "Sept 18, 19 ... @ 7:30pm"). The markup this scraper ' +
					"depends on has probably changed.",
			);
		}

		let stored = 0;
		let unparseableTime = 0;
		for (const p of performances) {
			const item = performanceToItem(p);
			if (!item) {
				unparseableTime++;
				ctx.note(
					`Performance of "${p.title}" on ${p.month} ${p.day}, ${p.year} had an ` +
						`unparseable time ("${p.timeText}") — not stored.`,
				);
				continue;
			}
			ctx.insertItem({
				...item,
				document_id: resolveDocumentId(
					ctx,
					doc.documentId,
					item.external_id,
					item.item_type,
				),
			});
			stored++;
		}

		const shows = new Set(performances.map((p) => p.title));
		ctx.note(
			`${SEASON_URL}: stored ${stored} of ${performances.length} parsed performance(s) ` +
				`across ${shows.size} show title(s), season year ${seasonYear}` +
				`${unparseableTime ? `, ${unparseableTime} skipped for an unparseable time` : ""}. ` +
				"Each bold date-list paragraph is one performance batch (e.g. an evening run or a " +
				"Sunday matinee); every date in it is expanded into its own item.",
		);
		ctx.note(
			"No API: sites.google.com is not WordPress and exposes no RSS/iCal, so the " +
				"server-rendered season page is the only machine-readable surface. Fragile points: " +
				'(1) the year comes from the page <title>\'s "<year> Season" text and is applied to ' +
				"every date on the page — silently wrong if a future season crosses a calendar-year " +
				"boundary, or if the URL is reused for a new season without updating the title; " +
				'(2) a show title with NO date-list paragraph after it (like the "Theatre on the ' +
				'Edge" festival banner, whose two one-acts each carry their own dates instead) ' +
				"correctly produces zero items for that title, but there is no way to distinguish " +
				"that from a show whose dates simply failed to parse; (3) title detection depends on " +
				"the theatre continuing to bold+italicize show names and leave everything else " +
				"(including subtitles, on the same title span as the name, e.g. POTUS's) not fully " +
				"upper-case within that span.",
		);
	},
};

export default scraper;
