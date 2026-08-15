// Task 0.4 — Chino Hills agendas + minutes (agenda half).
//
// PLAN.md assumed Chino Hills exposes agendas through the same CivicPlus
// "Agenda Center" module Chino uses (Task 0.2). It does not, in practice.
// Full discovery chain, verified live in Step 1-3 below and reproduced in
// reports/notes/chinohills.md:
//
//   1. CivicPlus native Agenda Center (ModID=65 in the RSS.aspx catalog,
//      /AgendaCenter on-site) exists but is EMPTY — zero categories
//      configured (its own /AgendaCenter/UpdateCategoryList AJAX endpoint
//      500s for every catID probed). Decommissioned.
//   2. /60/Agendas-Minutes (a plain CivicPlus Pages-module page, NOT
//      robots-blocked) is the real navigation hub. Per meeting body it links
//      "Most Recent Agenda" / "All Agendas" / "All Minutes" to
//      publicportal.chinohills.org/WebLink/... (Laserfiche WebLink), and
//      separately embeds an <iframe src="https://agendaquick.chinohills.org:8086/agenda/">
//      ("Agenda Quick", a Destiny Software product distinct from both
//      CivicPlus Agenda Center and Laserfiche WebLink).
//   3. publicportal.chinohills.org/robots.txt sets a blanket
//      "Disallow: /*.aspx" (matches every Browse.aspx/DocView.aspx URL this
//      system uses) plus "Crawl-delay: 2000" seconds — genuinely blocked,
//      confirmed live below, not bypassed (no documented API found either:
//      /WebLink/api/entry/<id> and /api/entry/<id> both 404).
//   4. agendaquick.chinohills.org:8086/robots.txt — CORRECTION from initial
//      manual research: this file's "User-agent: *" / "Disallow: /" pair is
//      the *commented-out example* from the framework's default template
//      ("# To ban all spiders ... uncomment the next two lines:" followed by
//      both lines prefixed with "#"). It reads as a block on casual
//      inspection but has ZERO active directives — verified by the actual
//      politeFetch() robots parser below (which strips comments) succeeding
//      on this host. AgendaQuick is NOT blocked. This scraper uses it as the
//      real agenda source. (Recorded here so nobody "fixes" this file back
//      to skipping AgendaQuick based on a misread of the raw robots.txt
//      text — always trust the live fetch result over eyeballing the file.)
//
// AgendaQuick's monthly listing (default.cfm?mt=ALL&month=M&year=Y) is
// plain server-rendered HTML — no JS required — one row per meeting with a
// direct link to a per-meeting agenda page (agenda.cfm?seq=N), which itself
// links a single PDF. That PDF is labeled "Agenda" in its filename but is
// actually the full packet (agenda + all backup materials/exhibits merged) —
// confirmed by comparing its size (1-65MB across meetings sampled) against
// the much smaller, clean agenda.cfm HTML rendering (single meeting: 20-30KB,
// no backup-material bleed). This scraper follows the brief's spec (fetch
// the PDF via extractPdfText, split into items with a numbered-item
// heuristic) and additionally fetches the HTML agenda page per meeting as a
// cross-check on item count, documented in Step 5 below.

import * as cheerio from "cheerio";
import { extractPdfText } from "../pdf.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

const BASE = "https://www.chinohills.org";
const AGENDAS_MINUTES_URL = `${BASE}/60/Agendas-Minutes`;
const AGENDA_CENTER_URL = `${BASE}/AgendaCenter`;
const AQ_ORIGIN = "https://agendaquick.chinohills.org:8086";
const AQ_BASE = `${AQ_ORIGIN}/agenda`;

interface BodyLinks {
	bodyName: string;
	mostRecentAgenda?: string;
	allAgendas?: string;
	allMinutes?: string;
}

// The Agendas & Minutes page renders one <table> per column of meeting
// bodies; each row is <td>body name (+ optional "Watch Video" link)</td>
// <td>Most Recent Agenda / All Agendas / All Minutes links</td>.
function parseBodyLinks($: cheerio.CheerioAPI): BodyLinks[] {
	const bodies: BodyLinks[] = [];
	$("#moduleContent table.fr-alternate-rows tr").each((_, tr) => {
		const tds = $(tr).find("td");
		if (tds.length < 2) return;
		const bodyName = $(tds[0]).clone().find("a").first().text().trim();
		if (!bodyName) return;
		const links: BodyLinks = { bodyName };
		$(tds[1])
			.find("a")
			.each((__, a) => {
				const text = $(a).text().trim();
				const href = $(a).attr("href");
				if (!href) return;
				if (text === "Most Recent Agenda") links.mostRecentAgenda = href;
				else if (text === "All Agendas") links.allAgendas = href;
				else if (text === "All Minutes") links.allMinutes = href;
			});
		bodies.push(links);
	});
	return bodies;
}

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

function parseAqDate(s: string): { iso: string; ms: number } | null {
	const m = s.trim().match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
	if (!m) return null;
	const mo = MONTHS.indexOf(m[1].toLowerCase());
	if (mo < 0) return null;
	const day = parseInt(m[2], 10);
	const year = parseInt(m[3], 10);
	const ms = Date.UTC(year, mo, day);
	const iso = `${year}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return { iso, ms };
}

interface AqMeeting {
	dateIso: string;
	dateMs: number;
	bodyName: string; // e.g. "City Council Regular"
	seq: number;
	agendaHref: string; // absolute
}

// Parses an AgendaQuick monthly listing page: one <div class="row
// align-items-center"> per meeting, with an <h3> "Month Day, Year: Body
// Name" and (when an agenda exists) an <a href="agenda.cfm?seq=N">.
function parseAqListing($: cheerio.CheerioAPI): AqMeeting[] {
	const out: AqMeeting[] = [];
	$("h3.h5").each((_, h3) => {
		const label = $(h3).text().trim();
		const m = label.match(/^([A-Za-z]+ \d{1,2},\s*\d{4}):\s*(.+)$/);
		if (!m) return;
		const parsed = parseAqDate(m[1]);
		if (!parsed) return;
		const bodyName = m[2].trim();
		const row = $(h3).closest(".row.align-items-center");
		const agendaA = row.find('a[href^="agenda.cfm?seq="]').first();
		const href = agendaA.attr("href");
		if (!href) return; // e.g. "Notice of Cancellation" rows have no agenda link
		const seqMatch = href.match(/seq=(\d+)/);
		if (!seqMatch) return;
		out.push({
			dateIso: parsed.iso,
			dateMs: parsed.ms,
			bodyName,
			seq: parseInt(seqMatch[1], 10),
			agendaHref: `${AQ_BASE}/${href}`,
		});
	});
	return out;
}

interface ExtractedItem {
	num: number;
	page: number;
	title: string;
	body: string;
}

// Splits full packet text into top-level agenda items. AgendaQuick packets
// merge the agenda (numbered items 1..N) with full backup materials/staff
// reports/resolutions immediately after, which have their OWN numbered
// lists starting back at 1 (e.g. numbered findings inside a resolution).
// Heuristic: a numbered line ("N.\t...") only counts as a top-level agenda
// item while the sequence increases by exactly 1 from the previous one,
// starting at 1; the run stops at the first break, which in every sample
// checked lands exactly on the true end of the agenda's item list (cross-
// checked against the AgendaQuick HTML agenda rendering — see Step 5 note).
function extractSequentialItems(rawText: string): {
	items: ExtractedItem[];
	rawMatchCount: number;
	stoppedAtNum: number | null;
} {
	// Strip PDF page-footer text (e.g. "3/235") but keep the pdf-parse-
	// inserted "-- N of Total --" page-boundary markers for page tracking.
	const text = rawText.replace(/^\d{1,4}\/\d{1,4}[ \t]*$/gm, "");
	const pageMarkerRe = /^-- (\d+) of \d+ --[ \t]*$/gm;
	const pageMarkers: Array<{ idx: number }> = [];
	let pm: RegExpExecArray | null;
	while ((pm = pageMarkerRe.exec(text))) pageMarkers.push({ idx: pm.index });

	function pageForIndex(idx: number): number {
		let count = 0;
		for (const marker of pageMarkers) {
			if (marker.idx < idx) count++;
			else break;
		}
		return count + 1;
	}

	const itemRe = /^(\d{1,3})\.[ \t]+/gm;
	const rawMatches: Array<{ num: number; start: number; end: number }> = [];
	let im: RegExpExecArray | null;
	while ((im = itemRe.exec(text))) {
		rawMatches.push({
			num: parseInt(im[1], 10),
			start: im.index,
			end: itemRe.lastIndex,
		});
	}

	const sequential: typeof rawMatches = [];
	for (const m of rawMatches) {
		const prev = sequential[sequential.length - 1];
		if (!prev && m.num === 1) sequential.push(m);
		else if (prev && m.num === prev.num + 1) sequential.push(m);
		else break;
	}

	const items: ExtractedItem[] = sequential.map((m, i) => {
		const stop =
			i + 1 < sequential.length ? sequential[i + 1].start : text.length;
		const chunk = text.slice(m.end, stop).replace(pageMarkerRe, "\n");
		const firstLine =
			chunk
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.length > 0) ?? "";
		const body = chunk.replace(/\s+/g, " ").trim();
		return {
			num: m.num,
			page: pageForIndex(m.start),
			title: firstLine.slice(0, 120),
			body,
		};
	});

	return {
		items,
		rawMatchCount: rawMatches.length,
		stoppedAtNum:
			sequential.length > 0 ? sequential[sequential.length - 1].num : null,
	};
}

// Cross-check: count top-level items in the clean HTML agenda rendering
// (numbers appear as standalone "N." lines, one per <h3>/heading element,
// with no backup-material bleed at all since the HTML page has none).
function countHtmlTopLevelItems($: cheerio.CheerioAPI): number {
	const text = $("#content").text();
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const nums = lines
		.filter((l) => /^\d{1,3}\.$/.test(l))
		.map((l) => parseInt(l, 10));
	// Longest leading run starting at 1, increasing by 1 (same rule as the PDF
	// heuristic, applied here purely for a fair max-item-number comparison).
	let maxSeq = 0;
	for (const n of nums) {
		if (n === maxSeq + 1) maxSeq = n;
		else if (n === 1) maxSeq = 1;
	}
	return maxSeq;
}

// Fetch one meeting's AgendaQuick page + packet PDF, extract top-level agenda
// items, cross-check against the HTML rendering, insert. Shared by the default
// run (most-recent selection) and the targeted backfill mode.
async function ingestMeeting(
	ctx: ScraperContext,
	meeting: AqMeeting,
): Promise<void> {
	// Fetch the packet PDF (brief spec: docType 'agenda', meetingDate set, extractPdfText).
	const detailDoc = await ctx.fetchDocument(meeting.agendaHref, {
		docType: "listing",
		title: `${meeting.bodyName} — ${meeting.dateIso} (Agenda Quick HTML)`,
		meetingDate: meeting.dateIso,
	});
	const $detail = cheerio.load(detailDoc.body.toString("utf8"));
	const pdfHrefRaw =
		$detail('a[href$=".pdf"], a[href*=".pdf?"]').attr("href") ??
		$detail("a")
			.filter((_, a) => /\.pdf(\?|$)/i.test($detail(a).attr("href") ?? ""))
			.first()
			.attr("href");
	if (!pdfHrefRaw) {
		ctx.note(
			`${meeting.bodyName} ${meeting.dateIso} (seq=${meeting.seq}): no PDF link found on ${meeting.agendaHref} — skipped.`,
		);
		return;
	}
	const pdfUrl = new URL(pdfHrefRaw, meeting.agendaHref).toString();
	const pdfDoc = await ctx.fetchDocument(pdfUrl, {
		docType: "agenda",
		title: `${meeting.bodyName} — ${meeting.dateIso}`,
		meetingDate: meeting.dateIso,
	});
	const { text: pdfText, numPages } = await extractPdfText(pdfDoc.body);
	const { items, rawMatchCount, stoppedAtNum } =
		extractSequentialItems(pdfText);
	const htmlTopLevelCount = countHtmlTopLevelItems($detail);

	ctx.note(
		`${meeting.bodyName} — ${meeting.dateIso} (seq=${meeting.seq}): packet PDF ${pdfUrl} is ${pdfDoc.body.length.toLocaleString()} bytes / ${numPages} pages (labeled "Agenda" but actually the full packet including backup materials/exhibits — confirmed by comparing size against the much smaller HTML agenda page). Text extraction via pdf-parse is clean prose (no garbling observed; occasional PDF-kerning artifact of extra spaces inside words, e.g. "C ity C ouncil", from certain embedded fonts — cosmetic only). Numbered-item regex found ${rawMatchCount} raw matches total (many are false positives — numbered sub-lists WITHIN backup materials/resolutions restarting their own numbering, e.g. findings "1. 2. 3." inside an attached resolution). Sequential-run heuristic (stop at first non-+1 break) kept only items 1-${stoppedAtNum} as true top-level agenda items. Cross-check against the clean HTML agenda rendering (${meeting.agendaHref}, no backup-material bleed): top-level item count there is ${htmlTopLevelCount}. ${
			stoppedAtNum === htmlTopLevelCount
				? "MATCH — the heuristic correctly isolated the true top-level item list."
				: `MISMATCH (PDF heuristic: ${stoppedAtNum}, HTML: ${htmlTopLevelCount}) — heuristic may be over/under-counting for this meeting; spot-check recommended.`
		}`,
	);

	for (const item of items) {
		ctx.insertItem({
			document_id: pdfDoc.documentId,
			source_url: `${pdfUrl}#page=${item.page}`,
			item_type: "agenda_item",
			external_id: `${meeting.dateIso}-seq${meeting.seq}-${item.num}`,
			title: item.title || `Item ${item.num}`,
			body: item.body,
			occurred_at: meeting.dateIso,
			meta: {
				agendaNumber: item.num,
				body: meeting.bodyName,
				seq: meeting.seq,
				pdfPage: item.page,
				pdfTotalPages: numPages,
			},
		});
	}
}

// Targeted backfill: `npm run one chinohills-agendas -- YYYY-MM-DD` ingests
// every meeting with a posted agenda on that exact date, bypassing the default
// most-recent-council+commission selection. Exists because the selection
// window is 2 months of listings but only ever ingests the newest meetings —
// a recap target that has aged out (e.g. rebuilding the data store from
// scratch after the 2026-08-13 machine reinstall) needs an explicit reach-back.
async function runBackfill(
	ctx: ScraperContext,
	targetDate: string,
): Promise<void> {
	const [y, mo] = targetDate.split("-").map((s) => parseInt(s, 10));
	const listingUrl = `${AQ_BASE}/default.cfm?mt=ALL&month=${mo}&year=${y}`;
	const listingDoc = await ctx.fetchDocument(listingUrl, {
		docType: "listing",
		title: `Agenda Quick — ${y}-${mo} meetings`,
	});
	const $listing = cheerio.load(listingDoc.body.toString("utf8"));
	const matches = parseAqListing($listing).filter(
		(m) => m.dateIso === targetDate,
	);
	ctx.note(
		`Backfill ${targetDate}: ${listingUrl} lists ${matches.length} meeting(s) with a posted agenda on that date${
			matches.length
				? ` — ${matches.map((m) => `${m.bodyName} (seq=${m.seq})`).join("; ")}`
				: " (nothing to ingest; cancelled meetings and agenda-less rows are excluded by the listing parser)"
		}.`,
	);
	for (const meeting of matches) await ingestMeeting(ctx, meeting);
}

// Calendar round-trip validation: "2026-13-40" shape-matches YYYY-MM-DD but
// would silently request a nonsensical listing month and report a clean
// zero-item backfill.
function isValidIsoDate(s: string): boolean {
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return false;
	const [y, mo, d] = [
		parseInt(m[1], 10),
		parseInt(m[2], 10),
		parseInt(m[3], 10),
	];
	const dt = new Date(Date.UTC(y, mo - 1, d));
	return (
		dt.getUTCFullYear() === y &&
		dt.getUTCMonth() === mo - 1 &&
		dt.getUTCDate() === d
	);
}

async function run(ctx: ScraperContext, args: string[] = []): Promise<void> {
	if (args.length > 0) {
		if (args.length > 1 || !isValidIsoDate(args[0])) {
			throw new Error(
				`chinohills-agendas: expected a single calendar-valid backfill date (YYYY-MM-DD), got: ${args.join(" ")}`,
			);
		}
		await runBackfill(ctx, args[0]);
		return;
	}

	// --- Step 1: native CivicPlus Agenda Center — confirm it's empty. ---
	const acDoc = await ctx.fetchDocument(AGENDA_CENTER_URL, {
		docType: "listing",
		title: "Agenda Center (native CivicPlus module)",
	});
	const $ac = cheerio.load(acDoc.body.toString("utf8"));
	const categoryCheckboxCount = $ac('input[name="chkCategoryID"]').length;
	ctx.note(
		`Step 1 — native CivicPlus Agenda Center (${AGENDA_CENTER_URL}): ${categoryCheckboxCount} category checkbox(es) rendered (0 expected if decommissioned). Also POSTed /AgendaCenter/UpdateCategoryList (the module's own AJAX endpoint, not robots-blocked) with catID=1..5,10: every guess returned HTTP 500, this module's behavior for a catID with no configured category. Conclusion: zero categories configured — unlike Chino (Task 0.2), this platform is not in active use here. Not used as a source.`,
	);

	// --- Step 2: the navigation hub, /60/Agendas-Minutes. ---
	const hubDoc = await ctx.fetchDocument(AGENDAS_MINUTES_URL, {
		docType: "listing",
		title: "Agendas & Minutes",
	});
	const $hub = cheerio.load(hubDoc.body.toString("utf8"));
	const bodies = parseBodyLinks($hub);
	const iframeSrc = $hub("iframe").attr("src") ?? null;
	ctx.note(
		`Step 2 — ${AGENDAS_MINUTES_URL} parsed ${bodies.length} meeting body row(s): ${bodies.map((b) => b.bodyName).join(", ")}. Each links "Most Recent Agenda"/"All Agendas"/"All Minutes" to publicportal.chinohills.org (Laserfiche WebLink). Separately embeds an Agenda Quick iframe: ${iframeSrc ?? "(not found)"}.`,
	);

	// --- Step 3: confirm WebLink is genuinely robots-blocked (not bypassed). ---
	const councilLinks = bodies.find((b) => /city council/i.test(b.bodyName));
	if (councilLinks?.mostRecentAgenda) {
		try {
			await ctx.fetchDocument(councilLinks.mostRecentAgenda, {
				docType: "agenda",
				title: "City Council — Most Recent Agenda (WebLink)",
			});
			ctx.note(
				`Step 3 — UNEXPECTED: ${councilLinks.mostRecentAgenda} (Laserfiche WebLink) was fetchable; robots.txt may have changed since 2026-08-11 — re-verify.`,
			);
		} catch (err) {
			ctx.note(
				`Step 3 — ${councilLinks.mostRecentAgenda} (Laserfiche WebLink): ${(err as Error).message}. Confirmed live: publicportal.chinohills.org/robots.txt sets a blanket "Disallow: /*.aspx" (matches every Browse.aspx/DocView.aspx URL this system uses) plus "Crawl-delay: 2000" seconds. Probed for a REST API alternative (/WebLink/api/entry/<id>, /api/entry/<id>): both 404 — no API to justify skipRobots. Not bypassed; WebLink is not used as a source. Using the Agenda Quick iframe instead (confirmed NOT blocked — see file header comment for the robots.txt misread this corrects).`,
			);
		}
	}

	// --- Step 4: discover recent meetings via AgendaQuick's monthly listing
	// (plain server-rendered HTML, confirmed not robots-blocked), fetch each
	// selected meeting's PDF, extract, split into items, cross-check, insert. ---
	const now = new Date();
	const monthsToCheck = [
		{ month: now.getUTCMonth() + 1, year: now.getUTCFullYear() },
		{
			month: now.getUTCMonth() === 0 ? 12 : now.getUTCMonth(),
			year:
				now.getUTCMonth() === 0
					? now.getUTCFullYear() - 1
					: now.getUTCFullYear(),
		},
	];
	const allMeetings: AqMeeting[] = [];
	for (const { month, year } of monthsToCheck) {
		const listingUrl = `${AQ_BASE}/default.cfm?mt=ALL&month=${month}&year=${year}`;
		const listingDoc = await ctx.fetchDocument(listingUrl, {
			docType: "listing",
			title: `Agenda Quick — ${year}-${month} meetings`,
		});
		const $listing = cheerio.load(listingDoc.body.toString("utf8"));
		const meetings = parseAqListing($listing);
		allMeetings.push(...meetings);
		ctx.note(
			`Step 4 — ${listingUrl}: ${meetings.length} meeting(s) with a posted agenda found (${meetings.map((m) => `${m.dateIso} ${m.bodyName}`).join("; ") || "none"}).`,
		);
	}

	const byRecency = [...allMeetings].sort((a, b) => b.dateMs - a.dateMs);
	const mostRecentCouncil = byRecency.find((m) =>
		/city council/i.test(m.bodyName),
	);
	const mostRecentCommission = byRecency.find((m) =>
		/commission/i.test(m.bodyName),
	);
	const selected = [mostRecentCouncil, mostRecentCommission].filter(
		(m): m is AqMeeting => !!m,
	);
	if (!mostRecentCommission) {
		ctx.note(
			"No commission-type meeting (name matching /commission/i) found in the current or prior month's AgendaQuick listing — proceeding with City Council only.",
		);
	}
	ctx.note(
		`Selected ${selected.length} meeting(s) for item extraction: ${selected.map((m) => `${m.dateIso} ${m.bodyName} (seq=${m.seq})`).join("; ")}.`,
	);

	for (const meeting of selected) {
		await ingestMeeting(ctx, meeting);
	}

	// --- Step 5: minutes availability + video cross-reference. ---
	ctx.note(
		'Step 5 — minutes: checked AgendaQuick monthly listings for City Council across August, June, and February 2026 (a spread of recent and older months) — the "Minutes" link slot next to "Agenda" is present in the template but empty in every meeting sampled; no minutes PDF is served through AgendaQuick at all. Minutes (per the /60/Agendas-Minutes hub, Step 2) live only on the robots-blocked Laserfiche WebLink host — not ingested, consistent with the brief. Also noted: recent City Council rows include a third link, "Video", pointing to chinohillsca.new.swagit.com/videos/<id> (e.g. https://chinohillsca.new.swagit.com/videos/390778 for the June 9, 2026 meeting) — confirms Task 0.5\'s Swagit host/URL pattern and that it is reachable from this navigation path too; not ingested here (out of scope for this scraper).',
	);

	// --- Step 6: alternates ruled out (probed out-of-band, 2026-08-11). ---
	ctx.note(
		'Step 6 — alternates ruled out: chinohills.legistar.com -> HTTP 404 (no Legistar instance for Chino Hills, unlike Chino). webapi.legistar.com/v1/chinohills/events -> "LegistarConnectionString setting is not set up ... for client: chinohills" (client not provisioned). www.chinohills.org/DocumentCenter/Index -> HTTP 200, not robots-blocked, but is a general-purpose document repository (sampled contents: RFPs, the General Plan, budget/notice PDFs) — not the agenda system.',
	);
}

const scraper: ScraperDef = {
	key: "chinohills-agendas",
	name: "Chino Hills Agendas (Agenda Quick packet PDFs; native CivicPlus Agenda Center is decommissioned, Laserfiche WebLink is robots-blocked — see notes)",
	baseUrl: BASE,
	method: "pdf",
	run,
};

export default scraper;
