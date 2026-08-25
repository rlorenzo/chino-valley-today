import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
	licenseRowTitle,
	OMITTED_COLUMNS,
	parseLicenseReport,
	parseReportDate,
	TARGET_CITIES,
} from "../../site/src/lib/abc.ts";
import { licenseRowAnchor } from "../pipeline/site-url.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const FIXTURE = readFileSync(
	join(import.meta.dirname, "__fixtures__", "abc-status-changes.html"),
	"utf8",
);

describe("parseLicenseReport", () => {
	test("keeps only the premises cities this site covers", () => {
		const report = parseLicenseReport(FIXTURE);
		assert.ok(report);
		assert.equal(report.totalRows, 4);
		assert.deepEqual(
			report.rows.map((r) => r.city),
			["CHINO", "CHINO", "CHINO HILLS"],
		);
	});

	// The extract line on the page says "N of M rows", and M has to be the
	// document's real row count, not the kept count — otherwise the page claims
	// to show a whole report while showing three rows of a statewide one.
	test("counts every row, not just the kept ones", () => {
		const report = parseLicenseReport(FIXTURE);
		assert.equal(report?.totalRows, 4);
		assert.equal(report?.rows.length, 3);
	});

	test("reads the report's own date, not the day it was fetched", () => {
		const report = parseLicenseReport(FIXTURE);
		assert.equal(report?.reportDate, "2026-08-12");
		assert.equal(
			report?.reportDateText,
			"Report Date: Wednesday, August 12, 2026",
		);
	});

	test("unpacks the owner cell's DBA line", () => {
		const row = parseLicenseReport(FIXTURE)?.rows[0];
		assert.equal(row?.primaryName, "ACME HOSPITALITY LLC");
		assert.equal(row?.dba, "THE CORNER");
	});

	test("an owner with no DBA on file is not read as one", () => {
		const row = parseLicenseReport(FIXTURE)?.rows[2];
		// Entity-encoded in the source; a cell read without re-parsing would leave
		// "CAF&Eacute;" in a licensee's name.
		assert.equal(row?.primaryName, "CAFÉ DEL SOL LLC");
		assert.equal(row?.dba, null);
	});

	// Rendering "SURREND" alone would state that a surrendered licence is
	// active. Both halves, or the reader is told the opposite of the record.
	test("a status change renders both halves", () => {
		const rows = parseLicenseReport(FIXTURE)?.rows ?? [];
		assert.equal(rows[0].status, "ACTIVE → SURREND");
		assert.equal(rows[1].status, "SURREND → REVOKED");
	});

	test("a single-status report row renders as itself", () => {
		assert.equal(parseLicenseReport(FIXTURE)?.rows[2].status, "ACTIVE");
	});

	test("dates become ISO and the premises address is assembled", () => {
		const row = parseLicenseReport(FIXTURE)?.rows[0];
		assert.equal(row?.originalIssueDate, "2019-03-04");
		assert.equal(row?.expiryDate, "2027-02-28");
		assert.equal(row?.premisesAddress, "1234 CENTRAL AVE, CHINO, CA 91710");
	});

	test("bytes that are not a licence report come back null", () => {
		assert.equal(parseLicenseReport("<html><body>nope</body></html>"), null);
		// A page with the table id but no recognisable columns is not one either.
		assert.equal(
			parseLicenseReport(
				'<table id="license_report"><thead><tr><th>x</th></tr></thead></table>',
			),
			null,
		);
	});

	test("parseReportDate survives a phrasing it cannot read", () => {
		assert.equal(parseReportDate("Report Date: sometime last week"), null);
		assert.equal(parseReportDate(""), null);
	});
});

describe("row anchors", () => {
	// THE DRIFT THIS EXISTS TO CATCH. The pipeline mints #row-<n> into a post's
	// frontmatter, permanently; the page renders the matching section id. The
	// two halves cannot import each other.
	test("the pipeline's anchor matches the page's section id", () => {
		const rows = parseLicenseReport(FIXTURE)?.rows ?? [];
		for (const row of rows) {
			assert.equal(licenseRowAnchor(row.rowIndex), `row-${row.rowIndex}`);
		}
	});

	// A licence can appear twice in one report — 78 of 410 rows in the
	// 2026-08-12 archive repeat a number — so an anchor keyed on the licence
	// number would send a citation about one status change to another.
	test("two rows for one licence get different anchors", () => {
		const rows = parseLicenseReport(FIXTURE)?.rows ?? [];
		const repeated = rows.filter((r) => r.licenseNo === "111111");
		assert.equal(repeated.length, 2);
		assert.notEqual(
			licenseRowAnchor(repeated[0].rowIndex),
			licenseRowAnchor(repeated[1].rowIndex),
		);
	});

	// Row indices count every row in the document, so a Chino row buried at
	// position 194 of 410 anchors at 194 — the kept-rows position would land the
	// reader on someone else entirely if the page ever rendered more rows.
	test("the index is the position in the document, not among kept rows", () => {
		const rows = parseLicenseReport(FIXTURE)?.rows ?? [];
		assert.deepEqual(
			rows.map((r) => r.rowIndex),
			[1, 3, 4],
		);
	});

	test("an item with no row_index degrades to the document page", () => {
		assert.equal(licenseRowAnchor(undefined), null);
		assert.equal(licenseRowAnchor("19"), null);
		assert.equal(licenseRowAnchor(0), null);
		assert.equal(licenseRowAnchor(1.5), null);
	});
});

describe("scope agreement with the scraper", () => {
	// The scraper filters at ingest and the archive page filters at render, and
	// they cannot import each other (site/src is Astro-scoped). Drifting apart
	// means a post citing a row the page then declines to show — a citation that
	// resolves to a page insisting the record is not there.
	test("TARGET_CITIES matches src/scrapers/abc-licenses.ts", () => {
		const scraper = readFileSync(
			join(repoRoot, "src/scrapers/abc-licenses.ts"),
			"utf8",
		);
		const match = scraper.match(/TARGET_CITIES = new Set\(\[([^\]]*)\]\)/);
		assert.ok(match, "abc-licenses.ts no longer declares TARGET_CITIES");
		const declared = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual([...TARGET_CITIES].sort(), declared.sort());
	});

	// The scraper has to keep writing meta.row_index, or every citation minted
	// after it stops silently degrades to the whole-document page.
	test("the scraper still records row_index", () => {
		const scraper = readFileSync(
			join(repoRoot, "src/scrapers/abc-licenses.ts"),
			"utf8",
		);
		const occurrences = scraper.match(/row_index: total/g) ?? [];
		assert.equal(
			occurrences.length,
			2,
			"both report types must record row_index",
		);
	});
});

describe("what the page does not reproduce", () => {
	// Stated on the page, so the omission is disclosed rather than silent. If
	// the columns ever start rendering, this sentence has to stop claiming they
	// do not.
	test("the omission notice names the columns", () => {
		assert.match(OMITTED_COLUMNS, /mailing address/);
		assert.match(OMITTED_COLUMNS, /escrow/);
	});

	// The parser must not carry them at all: a field that exists on the row is a
	// field a future template renders by accident.
	test("a mailing address never reaches the row", () => {
		const row = parseLicenseReport(FIXTURE)?.rows[0];
		assert.ok(row);
		const serialised = JSON.stringify(row);
		assert.doesNotMatch(serialised, /PRIVATE LN/);
		assert.doesNotMatch(serialised, /ESCROW CO/);
	});
});

describe("licenseRowTitle", () => {
	test("names the licence and what happened to it", () => {
		const rows = parseLicenseReport(FIXTURE)?.rows ?? [];
		assert.equal(licenseRowTitle(rows[0]), "Licence 111111 — ACTIVE → SURREND");
	});
});
