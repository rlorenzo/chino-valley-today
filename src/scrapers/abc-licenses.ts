// Task 0.8 — California ABC license activity (business early-warning).
//
// Discovery approach, in order of what was tried and what actually works —
// full narrative in reports/notes/abc-licenses.md:
//
// 1. The report pages (e.g. /licensing/licensing-reports/new-applications/)
//    render a <form id="daily-license-report-form"> that POSTs to
//    /wp-admin/admin-post.php (action=abclqs_daily_report, plus a WP nonce
//    field and an `abclqs-date` date field). This is the mechanism a browser
//    uses to pick a report date. It is POST-only (no fetch()/XHR anywhere in
//    the enqueued daily-report-form.js — it's a plain <form method="post">).
//    admin-post.php sits under /wp-admin/, and robots.txt's
//    `Allow: /wp-admin/admin-ajax.php` carve-out does NOT cover
//    admin-post.php, so it remains under the blanket `Disallow: /wp-admin/`.
//    We do not POST to it, full stop — this is exactly the "STOP AND REPORT
//    rather than bypass" case for robots, not a technical dead end we tried
//    to route around.
// 2. Even setting that aside: curl-probing the POST showed it 302-redirects
//    to a GET URL carrying the date as a query string
//    (?RPTTYPE=2&RPTDATE=MM/DD/YYYY on the *same* report page). That GET is
//    ALSO unusable — ANY query string on ANY abc.ca.gov URL (confirmed on
//    this report page, the single-license lookup page, and the bare
//    homepage) gets 301-redirected to the bare URL with the query string
//    stripped, even when replaying the exact cookies/Referer a browser would
//    send. This reads as a Cloudflare-edge anti-bot rule (no cf_clearance =
//    no query strings survive), not a robots.txt-governed path, and not
//    something a plain fetch can pass — reproducing what passes it would
//    mean impersonating a full JS-executing browser, which is out of scope
//    for a polite fetcher and not attempted.
// 3. What DOES work, is robots-compliant, and is plain GET: the report page
//    itself, fetched with NO query string, server-renders a real report for
//    whatever date the site currently treats as "current" (in practice: the
//    most recent business day). That's the only date we can ever see in a
//    single run — there is no way to walk back to an arbitrary earlier date.
//    This scraper fetches that one snapshot for both new-applications and
//    status-changes; no day-walk-back loop is implemented (see note below).
//
// Consequence for items.source_url: the per-license permalink pattern
// (/licensing/license-lookup/single-license/?RPTTYPE=12&LICENSE=<n>) is
// documented and DOES appear as the href on every license-number cell — but
// it is a query-string URL, so it is blocked by the same site-wide redirect
// (verified directly, including with a fresh cookie + matching Referer from
// having just loaded the report page — still 301s to a bare, contentless
// page). Per the task's own fallback instruction, source_url for every item
// here is the daily report page URL instead, with the limitation noted once
// below rather than silently degraded. The exact intended per-license URL is
// still recorded in each item's meta (`attempted_detail_url`) for Phase 1 to
// revisit (e.g. if a headless-browser fetch path is ever justified for this
// one host).
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { ScraperContext, ScraperDef } from "./types.ts";

const BASE = "https://www.abc.ca.gov";
const NEW_APPLICATIONS_URL = `${BASE}/licensing/licensing-reports/new-applications/`;
const STATUS_CHANGES_URL = `${BASE}/licensing/licensing-reports/status-changes/`;

const TARGET_CITIES = new Set(["CHINO", "CHINO HILLS"]);

// "Monday, August 10, 2026" -> "2026-08-10". Falls back to null (rather than
// throwing) if the site ever changes the phrasing; callers note that.
function parseReportDate(text: string): string | null {
	const cleaned = text.replace(/^Report Date:\s*/i, "").trim();
	const d = new Date(cleaned);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString().slice(0, 10);
}

// "08/10/2026" -> "2026-08-10"; passes through empty/unparseable input as null.
function mmddyyyyToIso(text: string): string | null {
	const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (!m) return null;
	const [, mm, dd, yyyy] = m;
	return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// DataTables columns include several visible=0 ones (City, County, Prem
// Street, ...) that only exist in the raw HTML/DOM, not the rendered table —
// exactly what we want, since cheerio reads the DOM, not the rendered view.
// Header text -> column index, built dynamically per table rather than
// hardcoded, since the two report types have different column sets/order.
function headerIndex(
	$: cheerio.CheerioAPI,
	table: cheerio.Cheerio<AnyNode>,
): Map<string, number> {
	const map = new Map<string, number>();
	table.find("thead th").each((i, th) => {
		const text = $(th).text().replace(/\s+/g, " ").trim().toLowerCase();
		if (text && !map.has(text)) map.set(text, i);
	});
	return map;
}

function cellText(
	_$: cheerio.CheerioAPI,
	cells: cheerio.Cheerio<AnyNode>,
	idx: number | undefined,
): string {
	if (idx === undefined) return "";
	return cells.eq(idx).text().replace(/\s+/g, " ").trim();
}

// Splits a cell's inner HTML on <br> and re-parses each fragment so entities
// decode correctly, dropping empty lines. Used for the combined
// "Primary Owner and Premises Addr." cell and the "Status Changed From/To"
// cell, both of which pack multiple logical lines into one <td> via <br>.
function cellLines(
	_$: cheerio.CheerioAPI,
	cells: cheerio.Cheerio<AnyNode>,
	idx: number | undefined,
): string[] {
	if (idx === undefined) return [];
	const html = cells.eq(idx).html() ?? "";
	return html
		.split(/<br\s*\/?>/i)
		.map((frag) =>
			cheerio
				.load(`<div>${frag}</div>`)("div")
				.text()
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter((s) => s.length > 0);
}

interface OwnerInfo {
	primaryName: string;
	dba: string | null;
}

// Owner cell renders as either:
//   "DBA: <dba name>" / "<owner name>" / "<street>," / "<city>, CA zip"
// or (no DBA on file):
//   "<owner name>" / "<street>," / "<city>, CA zip"
function parseOwnerLines(lines: string[]): OwnerInfo {
	if (lines.length === 0) return { primaryName: "", dba: null };
	const dbaMatch = lines[0].match(/^DBA:\s*(.+)$/i);
	if (dbaMatch) {
		return { primaryName: (lines[1] ?? "").trim(), dba: dbaMatch[1].trim() };
	}
	return { primaryName: lines[0].trim(), dba: null };
}

interface CommonFields {
	licenseNo: string;
	licenseType: string;
	licenseDup: string;
	primaryName: string;
	dba: string | null;
	premisesStreet: string;
	city: string;
	countyCode: string;
	zip: string;
	districtCode: string;
	geoCode: string;
	expiryDateRaw: string;
	expiryDateIso: string | null;
}

function parseCommon(
	$: cheerio.CheerioAPI,
	cells: cheerio.Cheerio<AnyNode>,
	cols: Map<string, number>,
	ownerColHeader: string,
): CommonFields {
	const licenseNo = cellText($, cells, cols.get("license number"));
	const typeDup = cellText($, cells, cols.get("type| dup"));
	const [licenseType, licenseDup] = typeDup.split("|").map((s) => s.trim());
	const ownerLines = cellLines($, cells, cols.get(ownerColHeader));
	const { primaryName, dba } = parseOwnerLines(ownerLines);
	const expiryDateRaw = cellText($, cells, cols.get("expir. date"));
	return {
		licenseNo,
		licenseType: licenseType ?? "",
		licenseDup: licenseDup ?? "",
		primaryName,
		dba,
		premisesStreet: cellText($, cells, cols.get("prem street")),
		city: cellText($, cells, cols.get("city")),
		countyCode: cellText($, cells, cols.get("county")),
		zip: cellText($, cells, cols.get("zip code")),
		districtCode: cellText($, cells, cols.get("district code")),
		geoCode: cellText($, cells, cols.get("geo code")),
		expiryDateRaw,
		expiryDateIso: mmddyyyyToIso(expiryDateRaw),
	};
}

function premisesAddress(c: CommonFields): string {
	const parts = [
		c.premisesStreet,
		c.city ? `${c.city}, CA ${c.zip}`.trim() : "",
	].filter(Boolean);
	return parts.join(", ");
}

function attemptedDetailUrl(licenseNo: string): string {
	return `${BASE}/licensing/license-lookup/single-license/?RPTTYPE=12&LICENSE=${licenseNo}`;
}

// Document titles use the RUN date, not the report's own as-of date — the
// latter is only known after parsing the fetched body, and re-fetching
// purely to relabel the title would double the requests made to the origin
// for no benefit (the true report date is recorded, unambiguously, in
// ctx.note() and in every item's meta.report_date below).
function runDateIso(): string {
	return new Date().toISOString().slice(0, 10);
}

async function ingestNewApplications(
	ctx: ScraperContext,
): Promise<{ matched: number; total: number }> {
	const doc = await ctx.fetchDocument(NEW_APPLICATIONS_URL, {
		docType: "license_report",
		title: `ABC new applications ${runDateIso()}`,
	});
	const $ = cheerio.load(doc.body.toString("utf8"));
	const rptDateText = $("#rptdate").text();
	const reportDate = parseReportDate(rptDateText);
	ctx.note(
		`new-applications report page rptdate text: "${rptDateText.trim()}" -> parsed ${reportDate ?? "UNPARSEABLE (see note below)"}.`,
	);
	if (!reportDate) {
		ctx.note(
			"Could not parse a report date from #rptdate on new-applications; items below use null occurred_at.",
		);
	}

	const table = $("#license_report");
	const cols = headerIndex($, table);
	let total = 0;
	let matched = 0;
	table.find("tbody > tr").each((_, tr) => {
		const cells = $(tr).find("> th, > td");
		if (cells.length === 0) return;
		total++;
		const common = parseCommon(
			$,
			cells,
			cols,
			"primary owner and premises addr.",
		);
		const city = common.city.trim().toUpperCase();
		if (!TARGET_CITIES.has(city)) return;
		matched++;
		const status = cellText($, cells, cols.get("status"));
		ctx.insertItem({
			document_id: doc.documentId,
			source_url: NEW_APPLICATIONS_URL,
			item_type: "license_event",
			external_id: `${common.licenseNo}-${reportDate ?? "unknown"}-${status || "unknown"}`,
			title:
				`${common.primaryName || common.dba || "Unknown applicant"} — Type ${common.licenseType} ${status}`.trim(),
			body: null,
			occurred_at: reportDate,
			meta: {
				report_type: "new_applications",
				report_date: reportDate,
				license_no: common.licenseNo,
				license_type: common.licenseType,
				license_type_dup: common.licenseDup,
				status,
				primary_name: common.primaryName,
				dba: common.dba,
				premises_address: premisesAddress(common),
				premises_street: common.premisesStreet,
				city,
				county_code: common.countyCode,
				zip: common.zip,
				district_code: common.districtCode,
				geo_code: common.geoCode,
				expiry_date: common.expiryDateIso ?? (common.expiryDateRaw || null),
				attempted_detail_url: attemptedDetailUrl(common.licenseNo),
			},
		});
	});
	ctx.note(
		`new-applications: ${total} statewide row(s) in this snapshot (report date ${reportDate ?? "unknown"}), ${matched} matched Chino/Chino Hills premises city.`,
	);
	return { matched, total };
}

async function ingestStatusChanges(
	ctx: ScraperContext,
): Promise<{ matched: number; total: number }> {
	const doc = await ctx.fetchDocument(STATUS_CHANGES_URL, {
		docType: "license_report",
		title: `ABC status changes ${runDateIso()}`,
	});
	const $ = cheerio.load(doc.body.toString("utf8"));
	const rptDateText = $("#rptdate").text();
	const reportDate = parseReportDate(rptDateText);
	ctx.note(
		`status-changes report page rptdate text: "${rptDateText.trim()}" -> parsed ${reportDate ?? "UNPARSEABLE (see note below)"}.`,
	);

	const table = $("#license_report");
	const cols = headerIndex($, table);
	let total = 0;
	let matched = 0;
	table.find("tbody > tr").each((_, tr) => {
		const cells = $(tr).find("> th, > td");
		if (cells.length === 0) return;
		total++;
		const common = parseCommon(
			$,
			cells,
			cols,
			"primary owner and premises addr.",
		);
		const city = common.city.trim().toUpperCase();
		if (!TARGET_CITIES.has(city)) return;
		matched++;
		const statusLines = cellLines($, cells, cols.get("status changed from/to"));
		const statusFrom = statusLines[0] ?? "";
		const statusTo = statusLines[1] ?? statusLines[0] ?? "";
		const issueDateRaw = cellText($, cells, cols.get("original issue date"));
		const transferFromTo = cellText($, cells, cols.get("transfer-from/to"));
		ctx.insertItem({
			document_id: doc.documentId,
			source_url: STATUS_CHANGES_URL,
			item_type: "license_event",
			external_id: `${common.licenseNo}-${reportDate ?? "unknown"}-${statusFrom || "unknown"}_${statusTo || "unknown"}`,
			title:
				`${common.primaryName || common.dba || "Unknown owner"} — Type ${common.licenseType} ${statusFrom}→${statusTo}`.trim(),
			body: null,
			occurred_at: reportDate,
			meta: {
				report_type: "status_changes",
				report_date: reportDate,
				license_no: common.licenseNo,
				license_type: common.licenseType,
				license_type_dup: common.licenseDup,
				status: `${statusFrom} -> ${statusTo}`,
				status_from: statusFrom,
				status_to: statusTo,
				primary_name: common.primaryName,
				dba: common.dba,
				premises_address: premisesAddress(common),
				premises_street: common.premisesStreet,
				city,
				county_code: common.countyCode,
				zip: common.zip,
				district_code: common.districtCode,
				geo_code: common.geoCode,
				original_issue_date:
					mmddyyyyToIso(issueDateRaw) ?? (issueDateRaw || null),
				expiry_date: common.expiryDateIso ?? (common.expiryDateRaw || null),
				transfer_from_to: transferFromTo || null,
				attempted_detail_url: attemptedDetailUrl(common.licenseNo),
			},
		});
	});
	ctx.note(
		`status-changes: ${total} statewide row(s) in this snapshot (report date ${reportDate ?? "unknown"}), ${matched} matched Chino/Chino Hills premises city.`,
	);
	return { matched, total };
}

const scraper: ScraperDef = {
	key: "abc-licenses",
	name: "California ABC license activity (new applications + status changes)",
	baseUrl: BASE,
	method: "html",
	async run(ctx) {
		ctx.note(
			"robots.txt: `Disallow: /wp-admin/` with `Allow: /wp-admin/admin-ajax.php` only. The actual date-selection form POSTs to /wp-admin/admin-post.php, which is NOT covered by that allow carve-out — so it remains disallowed. We never POST there. Both report pages fetched below (/licensing/licensing-reports/...) sit outside /wp-admin/ entirely and are unrestricted.",
		);
		ctx.note(
			'Date selection is architecturally unavailable to a plain fetcher: the POST-to-admin-post.php flow 302-redirects to a GET URL carrying ?RPTTYPE=&RPTDATE=, but ANY query string on ANY abc.ca.gov URL gets 301-redirected back to the bare URL with the query stripped (verified on the report page, the single-license lookup page, and the homepage; verified again with a fresh cookie + matching Referer replaying the exact request a real browser click would send — still stripped). This reads as a Cloudflare edge-level bot check, not a robots.txt matter. Consequence: no day-walk-back loop is implemented — each run can only see whatever single date the site currently treats as "current" (empirically the most recent business day). If that day has zero Chino/Chino Hills rows, this scraper will legitimately store zero items that run; it cannot search further back.',
		);
		ctx.note(
			'Per-license source_url ("single-license" detail page) is blocked by the same query-string redirect, so it cannot be used as items.source_url (see above) — every item below cites the daily report page URL instead, with the intended per-license URL preserved in meta.attempted_detail_url for Phase 1 to revisit.',
		);

		const newApps = await ingestNewApplications(ctx);
		const statusChanges = await ingestStatusChanges(ctx);

		const totalMatched = newApps.matched + statusChanges.matched;
		if (totalMatched === 0) {
			ctx.note(
				"ZERO Chino/Chino Hills rows found in either report on this run. Both snapshots reflect the single date the site currently defaults to (see date-selection note above) — this is not a 14-day walk-back, just the one day the site will show an unauthenticated GET.",
			);
		} else {
			ctx.note(
				`${totalMatched} Chino/Chino Hills license_event item(s) stored from the single available report date, with zero ability to walk back further days (see date-selection note above).`,
			);
		}

		ctx.note(
			'Open question 5 verdict: YES, premises city is a clean, directly filterable field — both report tables include a hidden (visible:0 in the DataTables config, but present in the raw HTML/DOM) "City" column with a plain uppercase city name (e.g. "CHINO", "CHINO HILLS", "LOS ANGELES"), not an address-text blob requiring parsing. Filtering is an exact match against that column; "Chino" and "Chino Hills" are distinct string values with no substring-overlap risk. A separate "County" hidden column exists too, but only as a numeric ABC-internal code (e.g. "36"), not a name — City is the field to filter on, County was not decoded.',
		);

		ctx.note(
			"Response format: server-rendered HTML (a DataTables-driven <table>), not JSON or CSV — despite the plugin enqueuing DataTables' CSV/PDF export buttons client-side, no JSON/CSV endpoint was found or needed; the DOM already carries every column DataTables would export, including the hidden ones.",
		);
	},
};

export default scraper;
