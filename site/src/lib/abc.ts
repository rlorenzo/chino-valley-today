/**
 * A California ABC daily licence report, as abc.ca.gov serves it, shaped for
 * reading.
 *
 * This exists because the report page is not date-stable: fetched with no query
 * string it renders whatever report the site currently treats as current, and
 * ANY query string on abc.ca.gov is 301-stripped at the edge, so there is no
 * per-report and no per-licence URL to cite (see SOURCES.md, abc-licenses).
 * A post published on Tuesday describing Monday's report cited a page that by
 * Wednesday showed neither. The archived bytes are the only stable record of
 * what the report said, so they are what a citation points at.
 *
 * THIS RENDERS AN EXTRACT, NOT THE WHOLE REPORT. Every report is statewide —
 * one archived status-changes report held 410 rows across 183 cities, two of
 * them in Chino. Standing up a permanent, self-hosted copy of 408 unrelated
 * licensees is not what a citation for those two rows requires, and it is not
 * this site's beat. The URL still names the exact bytes and the page states
 * what it is showing out of what; the provenance claim is unchanged.
 *
 * Deliberately free of Astro so src/site/abc-render.test.ts can import it.
 */
import * as cheerio from "cheerio";

/**
 * What `$(selector)` hands back.
 *
 * Inferred from cheerio's own API rather than imported as `Cheerio<AnyNode>`
 * from domhandler: naming domhandler here would make the site depend directly
 * on one of cheerio's transitive packages for a type it already exposes.
 */
type Selection = ReturnType<cheerio.CheerioAPI>;

/**
 * Premises cities this site reports on, uppercased for comparison.
 *
 * MUST match TARGET_CITIES in src/scrapers/abc-licenses.ts. The scraper filters
 * at ingest and this filters at render, and they cannot import each other —
 * src/site/abc-render.test.ts fails the build if they drift apart. Drifting
 * apart means a post citing a row the archive page then declines to show.
 */
export const TARGET_CITIES = ["CHINO", "CHINO HILLS"];

/** One licence row, as it stood in the archived report. */
export interface LicenseRow {
	/**
	 * 1-based position in the report's table, and the page anchor.
	 *
	 * Not the licence number: a licence can appear more than once in one report
	 * (78 of 410 rows in the archived status-changes report repeat a number), so
	 * a number-based anchor would silently send a citation to the wrong status
	 * change. The scraper stores this same index in meta.row_index.
	 */
	rowIndex: number;
	licenseNo: string;
	/** "PEND", or "ACTIVE → SURRENDERED" on a status-changes report. */
	status: string;
	licenseType: string;
	licenseDup: string;
	primaryName: string;
	dba: string | null;
	premisesAddress: string;
	city: string;
	originalIssueDate: string | null;
	expiryDate: string | null;
	transferFromTo: string | null;
	action: string | null;
	conditions: string | null;
	districtCode: string | null;
	geoCode: string | null;
}

export interface LicenseReport {
	/** "2026-08-12" — the report's own as-of date, not the day it was fetched. */
	reportDate: string | null;
	/** Verbatim, for when the phrasing changes and the parse above returns null. */
	reportDateText: string | null;
	/** Rows whose premises city this site covers. */
	rows: LicenseRow[];
	/** Every row in the document, so the extract can say what it is out of. */
	totalRows: number;
}

/**
 * Columns this page does NOT render, and the reason, stated on the page.
 *
 * A mailing address is frequently a sole proprietor's home, and the escrow line
 * carries a third party's street address. Neither backs any claim this site
 * publishes, so copying them onto our own domain buys nothing and costs
 * somebody their address.
 */
export const OMITTED_COLUMNS = "mailing address and escrow agent";

function text(node: Selection): string {
	return node.text().replace(/\s+/g, " ").trim();
}

/** Header text to column index, built per table: the two report types differ. */
function headerIndex(
	$: cheerio.CheerioAPI,
	table: Selection,
): Map<string, number> {
	const map = new Map<string, number>();
	table.find("thead th").each((i, th) => {
		const head = text($(th)).toLowerCase();
		if (head && !map.has(head)) map.set(head, i);
	});
	return map;
}

function cell(cells: Selection, idx: number | undefined): string {
	return idx === undefined ? "" : text(cells.eq(idx));
}

/**
 * A cell's <br>-separated lines, re-parsed so entities decode.
 *
 * The owner cell and the status cell both pack several logical lines into one
 * <td>, which is why they cannot be read with .text() alone.
 */
function cellLines(cells: Selection, idx: number | undefined): string[] {
	if (idx === undefined) return [];
	const html = cells.eq(idx).html() ?? "";
	return html
		.split(/<br\s*\/?>/i)
		.map((frag) => text(cheerio.load(`<div>${frag}</div>`)("div")))
		.filter(Boolean);
}

/**
 * The owner cell renders as either
 *   "DBA: <name>" / "<owner>" / "<street>," / "<city>, CA <zip>"
 * or, with no DBA on file, the same without the first line.
 */
function parseOwner(lines: string[]): {
	primaryName: string;
	dba: string | null;
} {
	if (lines.length === 0) return { primaryName: "", dba: null };
	const dba = lines[0].match(/^DBA:\s*(.+)$/i);
	return dba
		? { primaryName: (lines[1] ?? "").trim(), dba: dba[1].trim() }
		: { primaryName: lines[0].trim(), dba: null };
}

/** "Report Date: Wednesday, August 12, 2026" -> "2026-08-12". */
export function parseReportDate(raw: string): string | null {
	const cleaned = raw.replace(/^Report Date:\s*/i, "").trim();
	if (!cleaned) return null;
	const d = new Date(cleaned);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString().slice(0, 10);
}

/** "08/31/2027" -> "2027-08-31"; anything else back as null. */
function mmddyyyyToIso(raw: string): string | null {
	const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (!m) return null;
	const [, mm, dd, yyyy] = m;
	return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function orNull(s: string): string | null {
	return s.length > 0 ? s : null;
}

/**
 * Parses an archived report page, or returns null if the bytes are not one.
 *
 * Null rather than an empty report, for the same reason parseCapFeed does it:
 * "not a licence report" and "a licence report with nothing in Chino" are
 * different things to say to a reader, and the second is a real and frequent
 * state — most days the state's report has nothing here at all.
 */
export function parseLicenseReport(html: string): LicenseReport | null {
	const $ = cheerio.load(html);
	const table = $("#license_report");
	if (table.length === 0) return null;
	const cols = headerIndex($, table);
	if (!cols.has("license number")) return null;

	const wanted = new Set(TARGET_CITIES);
	const rows: LicenseRow[] = [];
	let totalRows = 0;

	table.find("tbody > tr").each((_, tr) => {
		const cells = $(tr).find("> th, > td");
		if (cells.length === 0) return;
		totalRows++;
		const rowIndex = totalRows;
		const city = cell(cells, cols.get("city")).toUpperCase();
		if (!wanted.has(city)) return;

		const typeDup = cell(cells, cols.get("type| dup"));
		const [licenseType, licenseDup] = typeDup.split("|").map((s) => s.trim());
		const { primaryName, dba } = parseOwner(
			cellLines(cells, cols.get("primary owner and premises addr.")),
		);

		// One report type carries a plain "Status"; the other carries a two-line
		// "Status Changed From/To". Rendering the second as a single word would
		// state that a surrendered licence is active.
		const statusLines = cellLines(cells, cols.get("status changed from/to"));
		const status =
			statusLines.length > 1
				? `${statusLines[0]} → ${statusLines[1]}`
				: (statusLines[0] ?? cell(cells, cols.get("status")));

		const street = cell(cells, cols.get("prem street"));
		const zip = cell(cells, cols.get("zip code"));
		const premisesAddress = [street, city ? `${city}, CA ${zip}`.trim() : ""]
			.filter(Boolean)
			.join(", ");

		const expiryRaw = cell(cells, cols.get("expir. date"));
		const issueRaw = cell(cells, cols.get("original issue date"));

		rows.push({
			rowIndex,
			licenseNo: cell(cells, cols.get("license number")),
			status,
			licenseType: licenseType ?? "",
			licenseDup: licenseDup ?? "",
			primaryName,
			dba,
			premisesAddress,
			city,
			originalIssueDate: mmddyyyyToIso(issueRaw) ?? orNull(issueRaw),
			expiryDate: mmddyyyyToIso(expiryRaw) ?? orNull(expiryRaw),
			transferFromTo: orNull(cell(cells, cols.get("transfer-from/to"))),
			action: orNull(cell(cells, cols.get("action"))),
			conditions: orNull(cell(cells, cols.get("conditions"))),
			districtCode: orNull(cell(cells, cols.get("district code"))),
			geoCode: orNull(cell(cells, cols.get("geo code"))),
		});
	});

	const reportDateText = orNull(text($("#rptdate")));
	return {
		reportDate: reportDateText ? parseReportDate(reportDateText) : null,
		reportDateText,
		rows,
		totalRows,
	};
}

/** "Licence 681107 — PEND", the row's own title line. */
export function licenseRowTitle(row: LicenseRow): string {
	const number = row.licenseNo || "unnumbered";
	return row.status ? `Licence ${number} — ${row.status}` : `Licence ${number}`;
}
