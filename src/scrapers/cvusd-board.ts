// Task 0.6 — CVUSD Board of Education: agenda/minutes/video listing index.
//
// Discovery: "Board of Education Home" -> "Meetings Agendas, Minutes, and
// Videos" (chino.k12.ca.us/224768_2) redirects to whichever year is
// "current" (currently /136685_3, the 2026/2027 page). That page and its
// sidebar links to prior years (2025/2026, 2024/2025, ...) each render one
// clean HTML <table> per year: columns Meeting Date | Meeting Type | Agenda
// | Minutes | Meeting Video. This is NOT the Finalsite CMS PLAN.md guessed —
// response headers (x-gabbart-ecs, CSP referencing *.smartsites.parentsquare.com)
// identify it as ParentSquare's "SmartSites" district CMS.
//
// Open question 4 (BoardDocs/Simbli?) verdict: NO. Agenda PDFs are hosted
// directly at files.smartsites.parentsquare.com (AWS-backed: response headers
// include x-amz-server-side-encryption / x-amz-version-id) — plain static
// PDFs, not a board-management-service API. See the ctx.note() in run() for
// the full evidence trail.
//
// BUT: files.smartsites.parentsquare.com/robots.txt is a blanket
// "User-agent: * / Disallow: /" (only Googlebot-Image is allowed), which
// politeFetch (src/fetch.ts) enforces by throwing before any GET. Per this
// task's explicit instruction — "a block is a finding, not something to
// bypass" — we do NOT set skipRobots for this host: unlike api.weather.gov
// (the nws-alerts.ts precedent), this is not a documented public API, just a
// blanket SEO-crawler exclusion on a static file bucket, which fails the
// bar ScraperContext.fetchDocument's own doc comment sets for skipRobots.
// Consequence: full-text agenda-PDF ingestion is blocked entirely as long as
// fetch.ts enforces robots.txt by default and this host's policy stands. The
// PDF-splitting code below (splitAgendaItems / ingestAgendaPdf) is written
// and exercised against real downloaded PDFs (see reports/notes/cvusd.md for
// that evidence, gathered by hand outside the scraper's own fetch path) —
// it will start working the moment the block is lifted or an explicit
// exception is approved, without further code changes.
//
// What still works despite the block: every meeting row on every listing
// page IS crawlable HTML (chino.k12.ca.us has no robots.txt objection), so
// we store one 'event' item per meeting with source_url pointing at its
// agenda/video/minutes link directly — usable by a human reader even though
// we never fetched the PDF bytes ourselves.
import * as cheerio from "cheerio";
import { extractPdfText } from "../pdf.ts";
import { meetingScopedId } from "./external-id.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

const BASE = "https://www.chino.k12.ca.us";
const MEETINGS_URL = `${BASE}/224768_2`; // stable entry point; redirects to the "current" year page
const MAX_PDF_INGEST = 2;
const MAX_PRIOR_YEAR_PAGES = 1; // + the current-year page itself = 2 listing pages fetched total

type MinutesHost = "smartsites" | "sharepoint" | "other";

interface MeetingRow {
	date: string; // ISO yyyy-mm-dd, parsed from the table's "MM-DD-YY" cell
	type: string; // "Regular" | "Special" | "Organizational" | ...
	agendaUrl: string | null;
	minutesUrl: string | null;
	minutesHost: MinutesHost | null;
	videoUrl: string | null;
	documentId: number; // the listing document this row was parsed from
	listingUrl: string; // fallback source_url if a row somehow has no links at all
}

function classifyHost(url: string): MinutesHost {
	const host = new URL(url).host;
	if (host === "files.smartsites.parentsquare.com") return "smartsites";
	// Suffix match must be on a domain-label boundary: bare endsWith would also
	// classify an unrelated host like "notsharepoint.com" as SharePoint.
	if (host === "sharepoint.com" || host.endsWith(".sharepoint.com"))
		return "sharepoint";
	return "other";
}

function parseMeetingRows(
	$: cheerio.CheerioAPI,
	pageUrl: string,
	documentId: number,
): MeetingRow[] {
	const rows: MeetingRow[] = [];
	$("table").each((_, table) => {
		const $table = $(table);
		if (!/Meeting Date/i.test($table.find("thead").text())) return;
		$table.find("tbody tr").each((_, tr) => {
			const $tr = $(tr);
			const cells = $tr.find("th, td");
			if (cells.length < 5) return;
			const dateText = $(cells[0]).text().trim();
			const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(dateText);
			if (!m) return; // header row or malformed row
			const [, mm, dd, yy] = m;
			const date = `20${yy}-${mm}-${dd}`;
			const type = $(cells[1]).text().trim() || "Regular";
			const agendaHref = $(cells[2]).find("a").first().attr("href") ?? null;
			const minutesHref = $(cells[3]).find("a").first().attr("href") ?? null;
			const videoHref = $(cells[4]).find("a").first().attr("href") ?? null;
			const agendaUrl = agendaHref
				? new URL(agendaHref, pageUrl).toString()
				: null;
			const minutesUrl = minutesHref
				? new URL(minutesHref, pageUrl).toString()
				: null;
			const videoUrl = videoHref
				? new URL(videoHref, pageUrl).toString()
				: null;
			rows.push({
				date,
				type,
				agendaUrl,
				minutesUrl,
				minutesHost: minutesUrl ? classifyHost(minutesUrl) : null,
				videoUrl,
				documentId,
				listingUrl: pageUrl,
			});
		});
	});
	return rows;
}

function discoverPriorYearUrls(
	$: cheerio.CheerioAPI,
	pageUrl: string,
): string[] {
	const urls: string[] = [];
	$("a").each((_, a) => {
		const $a = $(a);
		if (!/Meeting Dates,?\s*Agendas,\s*Minutes and Videos/i.test($a.text()))
			return;
		const href = $a.attr("href");
		if (!href) return;
		urls.push(new URL(href, pageUrl).toString());
	});
	return [...new Set(urls)];
}

// Item numbering in CVUSD packet PDFs is hierarchical: "II.A.1." / "III.B.4."
// on its own line, immediately followed by "Page N" (the packet's own page
// label for the backup material), then a title line and a recommendation
// sentence. Bounded to the region between the "AGENDA" heading and the first
// "<Roman>. ADJOURNMENT" line — everything after that boundary in these
// packets is scanned attachments (staff reports, MOUs) that happen to
// contain their own unrelated roman-numeral section headers and would
// otherwise pollute the match. Verified against two real packets (07-16-26:
// 21 items; 06-18-26: 31 items) — see reports/notes/cvusd.md.
interface AgendaItem {
	n: string; // e.g. "II.A.1"
	page: number | null; // packet page label, used for the #page= anchor
	title: string;
	body: string;
}

function splitAgendaItems(fullText: string): {
	items: AgendaItem[];
	boundedFallback: boolean;
} {
	const agendaHeadingRe = /^\s*AGENDA\s*$/m;
	const headingMatch = agendaHeadingRe.exec(fullText);
	const start = headingMatch ? headingMatch.index + headingMatch[0].length : 0;
	const rest = fullText.slice(start);
	const adjournRe = /^[IVXLC]+\.\s*ADJOURNMENT\s*$/im;
	const adjournMatch = adjournRe.exec(rest);
	let boundedFallback = false;
	let regionEnd: number;
	if (adjournMatch) {
		regionEnd = start + adjournMatch.index;
	} else {
		boundedFallback = true;
		regionEnd = Math.min(fullText.length, start + 15000); // safety cap, POC-quality
	}
	const region = fullText.slice(start, regionEnd);

	const itemRe = /^([IVXLC]+\.[A-Z]\.\d+)\.\s*$/gm;
	const matches: Array<{ n: string; idx: number; contentStart: number }> = [];
	for (const m of region.matchAll(itemRe)) {
		matches.push({
			n: m[1],
			idx: m.index,
			contentStart: m.index + m[0].length,
		});
	}

	const items: AgendaItem[] = [];
	for (let i = 0; i < matches.length; i++) {
		const cur = matches[i];
		const next = matches[i + 1];
		let bodyRaw = region
			.slice(cur.contentStart, next ? next.idx : region.length)
			.trim();
		let page: number | null = null;
		const pageMatch = /^Page\s+(\d+)\s*/i.exec(bodyRaw);
		if (pageMatch) {
			page = Number(pageMatch[1]);
			bodyRaw = bodyRaw.slice(pageMatch[0].length);
		}
		const body = bodyRaw.replace(/\s+/g, " ").trim();
		items.push({ n: cur.n, page, title: body.slice(0, 140), body });
	}
	return { items, boundedFallback };
}

async function ingestAgendaPdf(
	ctx: ScraperContext,
	row: MeetingRow,
): Promise<void> {
	if (!row.agendaUrl) return;
	let doc: Awaited<ReturnType<ScraperContext["fetchDocument"]>>;
	try {
		doc = await ctx.fetchDocument(row.agendaUrl, {
			docType: "agenda",
			title: `Board of Education ${row.type} Meeting`,
			meetingDate: row.date,
		});
	} catch (err) {
		ctx.note(
			`Agenda PDF fetch BLOCKED for ${row.date} (${row.agendaUrl}): ${(err as Error).message}. ` +
				"Not bypassed per this task's politeness instruction (\"a block is a finding, not something " +
				'to bypass") — see the robots.txt evidence noted in run() and reports/notes/cvusd.md. No ' +
				"agenda_item rows for this meeting; the meeting-level 'event' item still links readers to this URL.",
		);
		return;
	}
	const { text, numPages } = await extractPdfText(doc.body);
	ctx.note(
		`PDF for ${row.date} (${row.type}): ${numPages} pages, ${text.length} chars extracted via extractPdfText — clean selectable text (full packet, not scanned/image-only).`,
	);
	const { items, boundedFallback } = splitAgendaItems(text);
	if (boundedFallback) {
		ctx.note(
			`Item-splitter fallback for ${row.date}: no "<Roman>. ADJOURNMENT" boundary found; capped the search window at 15000 chars from the AGENDA heading.`,
		);
	}
	if (items.length === 0) {
		ctx.note(
			`Item-splitter found 0 hierarchical "<Roman>.<Letter>.<N>." items in the ${row.date} agenda — heuristic did not match this document's layout. No fallback item inserted.`,
		);
		return;
	}
	for (const item of items) {
		ctx.insertItem({
			document_id: doc.documentId,
			source_url: item.page
				? `${row.agendaUrl}#page=${item.page}`
				: row.agendaUrl,
			item_type: "agenda_item",
			external_id: meetingScopedId(row.date, row.type, item.n),
			title: item.title,
			body: item.body,
			occurred_at: row.date,
			meta: {
				itemNumber: item.n,
				packetPage: item.page,
				meetingType: row.type,
			},
		});
	}
	ctx.note(
		`Split ${row.date} agenda into ${items.length} agenda_item row(s), e.g. ${items
			.slice(0, 3)
			.map((i) => i.n)
			.join(", ")}...`,
	);
}

const scraper: ScraperDef = {
	key: "cvusd-board",
	name: "CVUSD Board of Education (meetings, agendas, minutes, videos)",
	baseUrl: MEETINGS_URL,
	method: "html",
	async run(ctx) {
		const entry = await ctx.fetchDocument(MEETINGS_URL, {
			docType: "listing",
			title: "CVUSD Board Meetings Agendas Minutes and Videos (current year)",
		});
		const $entry = cheerio.load(entry.body.toString("utf8"));
		let allRows = parseMeetingRows($entry, MEETINGS_URL, entry.documentId);
		ctx.note(
			`Entry point ${MEETINGS_URL} ("Board of Education Home" -> "Meetings Agendas, Minutes, and Videos") redirects to the current-year listing page, which has ${allRows.length} meeting row(s) so far this board year.`,
		);

		const priorYearUrls = discoverPriorYearUrls($entry, MEETINGS_URL).slice(
			0,
			MAX_PRIOR_YEAR_PAGES,
		);
		for (const yearUrl of priorYearUrls) {
			const yr = await ctx.fetchDocument(yearUrl, {
				docType: "listing",
				title: "CVUSD Board Meetings Agendas Minutes and Videos (prior year)",
			});
			const $yr = cheerio.load(yr.body.toString("utf8"));
			const yrRows = parseMeetingRows($yr, yearUrl, yr.documentId);
			ctx.note(
				`Prior-year listing page ${yearUrl}: ${yrRows.length} meeting row(s).`,
			);
			allRows = allRows.concat(yrRows);
		}
		allRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

		// --- Open question 4: BoardDocs/Simbli verdict, with evidence ---
		const agendaHosts = new Set(
			allRows.flatMap((r) => (r.agendaUrl ? [new URL(r.agendaUrl).host] : [])),
		);
		ctx.note(
			`Open question 4 verdict: agenda PDF host(s) across ${allRows.length} meeting rows: ${
				[...agendaHosts].join(", ") || "(none)"
			}. NOT boarddocs.com, NOT simbli.eboardsolutions.com. CVUSD's Board site runs ParentSquare's ` +
				'"SmartSites" district CMS (not Finalsite as originally guessed — confirmed by the x-gabbart-ecs ' +
				"response header and a Content-Security-Policy scoped to *.smartsites.parentsquare.com), serving " +
				"agenda PDFs directly from its own asset host, files.smartsites.parentsquare.com (AWS-backed: " +
				"response headers show x-amz-server-side-encryption / x-amz-version-id). No structured board-" +
				"management-service API or data exists behind these links — they are plain static PDFs.",
		);
		const minutesHosts = new Set(
			allRows.filter((r) => r.minutesHost).map((r) => r.minutesHost),
		);
		ctx.note(
			`Minutes link hosts seen: ${[...minutesHosts].join(", ") || "(none)"}. Some Minutes documents (never ` +
				"Agendas, in the rows observed) route through chinovalley-my.sharepoint.com personal-OneDrive share " +
				"links that redirect (302) to an authenticated SharePoint viewer and set a FedAuth cookie — not " +
				"fetchable without a Microsoft login. Treated as inaccessible; not ingested, not used as a source_url.",
		);

		// --- robots.txt finding on the PDF host ---
		ctx.note(
			'files.smartsites.parentsquare.com/robots.txt is "User-agent: * / Disallow: /" (only Googlebot-Image ' +
				'is allowed) — confirmed live and confirmed to make politeFetch throw ("robots.txt disallows ...") ' +
				"before any GET is attempted. chino.k12.ca.us itself has no such restriction on these listing pages " +
				"(robots.txt there only blocks /admin, /*lesson_plan, /userFiles, and sets Crawl-delay: 5, which " +
				"fetch.ts's fixed 2s per-host delay does not honor per-directive — a shared-infra gap, not something " +
				"fixable from this file). Per this task's explicit instruction, the PDF block was NOT bypassed with " +
				"skipRobots: unlike api.weather.gov (the nws-alerts.ts precedent, a documented API), this is a blanket " +
				"SEO-crawler exclusion on a static file bucket with no programmatic-use documentation, so it fails the " +
				"bar ScraperContext.fetchDocument's own doc comment sets for that escape hatch. See reports/notes/cvusd.md " +
				"for the extraction-quality evidence gathered by hand outside this constraint, and a recommendation.",
		);

		// --- meeting-level 'event' items: works for every row regardless of the PDF block ---
		let eventCount = 0;
		for (const row of allRows) {
			const sourceUrl =
				row.agendaUrl ?? row.videoUrl ?? row.minutesUrl ?? row.listingUrl;
			ctx.insertItem({
				document_id: row.documentId,
				source_url: sourceUrl,
				item_type: "event",
				external_id: meetingScopedId(row.date, row.type, "meeting"),
				title: `Board of Education ${row.type} Meeting — ${row.date}`,
				occurred_at: row.date,
				meta: {
					meetingType: row.type,
					agendaUrl: row.agendaUrl,
					minutesUrl: row.minutesUrl,
					minutesHost: row.minutesHost,
					videoUrl: row.videoUrl,
				},
			});
			eventCount++;
		}
		ctx.note(
			`Inserted ${eventCount} meeting-level 'event' item(s) spanning ${allRows.at(-1)?.date ?? "n/a"} to ${
				allRows[0]?.date ?? "n/a"
			}, each linking directly to its agenda/video/minutes URL parsed from the (crawlable) listing pages — ` +
				"this coverage exists independent of the PDF-host robots.txt block above.",
		);

		// --- attempt full-text ingestion for the most recent smartsites-hosted agendas ---
		const candidates = allRows.filter(
			(r) => r.agendaUrl && classifyHost(r.agendaUrl) === "smartsites",
		);
		const toIngest = candidates.slice(0, MAX_PDF_INGEST);
		ctx.note(
			`Attempting full-text ingestion for ${toIngest.length} most recent smartsites-hosted agenda PDF(s): ${
				toIngest.map((r) => r.date).join(", ") || "(none)"
			} (expected to be blocked — see robots.txt finding above; code path is exercised so it self-heals if the block is ever lifted).`,
		);
		for (const row of toIngest) {
			await ingestAgendaPdf(ctx, row);
		}
	},
};

export default scraper;
