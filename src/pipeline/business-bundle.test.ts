import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	isBusinessRelevant,
	isoWeekOfOccurredAt,
	licenseEventDetail,
} from "./bundle.ts";

// 2026-01-01 is a Thursday, so 2026-W01 runs Mon 2025-12-29 .. Sun 2026-01-04
// and 2026 is a 53-week ISO year. W33 runs Mon 2026-08-10 .. Sun 2026-08-16.

describe("isoWeekOfOccurredAt", () => {
	test("date-only string maps to its own UTC week", () => {
		assert.equal(isoWeekOfOccurredAt("2026-08-12"), "2026-W33");
	});

	test("full ISO instant uses UTC calendar fields", () => {
		assert.equal(isoWeekOfOccurredAt("2026-08-12T07:00:00.000Z"), "2026-W33");
	});

	test("week boundary: Sunday belongs to the prior week, Monday starts the next", () => {
		assert.equal(isoWeekOfOccurredAt("2026-08-09"), "2026-W32");
		assert.equal(isoWeekOfOccurredAt("2026-08-10"), "2026-W33");
		assert.equal(isoWeekOfOccurredAt("2026-08-16"), "2026-W33");
	});

	test("boundary is UTC, not local: a late-UTC Sunday instant stays in the UTC week", () => {
		// 2026-08-10T06:59:59Z is still Aug 9 in Pacific time; the UTC rule puts
		// it in W33 regardless of the machine's timezone.
		assert.equal(isoWeekOfOccurredAt("2026-08-10T06:59:59.000Z"), "2026-W33");
		assert.equal(isoWeekOfOccurredAt("2026-08-09T23:59:59.000Z"), "2026-W32");
	});

	test("ISO year differs from calendar year at the boundary", () => {
		assert.equal(isoWeekOfOccurredAt("2025-12-29"), "2026-W01");
		// 2027-01-01 is a Friday, so it falls in the last week of ISO year 2026.
		assert.equal(isoWeekOfOccurredAt("2027-01-01"), "2026-W53");
	});

	test("naive datetimes (no zone suffix) are anchored to UTC, not machine-local time", () => {
		// Parsed as local time these shift into an adjacent week on any non-UTC
		// machine (W34 in America/Los_Angeles for the first, W32 at UTC+14 for
		// the second). SQLite-style space separator included.
		assert.equal(isoWeekOfOccurredAt("2026-08-16 23:00:00"), "2026-W33");
		assert.equal(isoWeekOfOccurredAt("2026-08-10T00:00:00"), "2026-W33");
		assert.equal(isoWeekOfOccurredAt("2026-08-16T23:59:59.500"), "2026-W33");
	});

	test("null and unparseable inputs return null", () => {
		assert.equal(isoWeekOfOccurredAt(null), null);
		assert.equal(isoWeekOfOccurredAt(""), null);
		assert.equal(isoWeekOfOccurredAt("not a date"), null);
	});
});

describe("isBusinessRelevant", () => {
	test("matches the business-relevant patterns in titles", () => {
		assert.ok(
			isBusinessRelevant(
				"PL25-0085 (Special Conditional Use Permit), PL25-0086 (Site Approval) and Development Agreement",
				null,
			),
		);
		assert.ok(
			isBusinessRelevant(
				"Business License Reform and Small Business Protection Measure​.",
				null,
			),
		);
		assert.ok(
			isBusinessRelevant("Zoning Code Amendment for industrial parcels", null),
		);
		assert.ok(isBusinessRelevant("Zone Change 2026-001", null));
		assert.ok(
			isBusinessRelevant("Rezoning of the northeast corner parcel", null),
		);
		assert.ok(
			isBusinessRelevant("Massage establishment licensing update", null),
		);
	});

	test("matches in the body when the title is silent", () => {
		assert.ok(
			isBusinessRelevant(
				"Public hearing",
				"Consider a conditional use permit for a drive-through.",
			),
		);
	});

	test("does not match unrelated council business", () => {
		assert.equal(
			isBusinessRelevant("Approval of Meeting Minutes", null),
			false,
		);
		assert.equal(
			isBusinessRelevant("Proclamation Honoring Volunteer of the Year", null),
			false,
		);
		assert.equal(
			isBusinessRelevant(
				"Award of a landscape maintenance contract",
				"Ayala Park irrigation.",
			),
			false,
		);
		assert.equal(isBusinessRelevant(null, null), false);
	});

	test('"zone"/"zones" alone does not match (only zoning/zone change/rezoning)', () => {
		assert.equal(isBusinessRelevant("School zone traffic study", null), false);
	});

	test("near-miss phrasings do not match — the patterns are anchored and specific", () => {
		// Each line kills a plausible loosening of one pattern: bare "permit" or
		// "use permit" (vs conditional use permit), bare "agreement" (vs
		// development agreement), "lic*" or unanchored "licens" (vs \blicens*),
		// and an invented catch-all like \bproject\b.
		assert.equal(
			isBusinessRelevant("Encroachment permit for sidewalk repair", null),
			false,
		);
		assert.equal(
			isBusinessRelevant("Temporary use permit for a community carnival", null),
			false,
		);
		assert.equal(
			isBusinessRelevant(
				"Professional services agreement for irrigation design",
				null,
			),
			false,
		);
		assert.equal(
			isBusinessRelevant("Licorice vendor booth at the community fair", null),
			false,
		);
		assert.equal(
			isBusinessRelevant("Discussion of unlicensed street vending", null),
			false,
		);
		assert.equal(
			isBusinessRelevant(
				"Establish a Capital Project for storm drain repairs",
				null,
			),
			false,
		);
	});
});

describe("licenseEventDetail", () => {
	const META = {
		report_type: "status_changes",
		report_date: "2026-08-12",
		license_no: "399692",
		license_type: "20",
		status: "ACTIVE -> REVPEN",
		primary_name: "STOOPS, JEFFREY D",
		dba: "LATIMEX MARKET",
		premises_address: "11742 CENTRAL AVE, CHINO, CA 91710",
		original_issue_date: "2004-08-05",
		expiry_date: "2026-05-31",
		transfer_from_to: "20-269685",
		attempted_detail_url:
			"https://www.abc.ca.gov/licensing/license-lookup/single-license/?RPTTYPE=12&LICENSE=399692",
	};

	test("renders every gate-relevant fact and never a URL", () => {
		const detail = licenseEventDetail(META);
		assert.ok(detail);
		for (const fact of [
			"License 399692",
			"Type 20",
			"ACTIVE -> REVPEN",
			"2026-08-12",
			"STOOPS, JEFFREY D",
			"LATIMEX MARKET",
			"11742 CENTRAL AVE, CHINO, CA 91710",
			"2004-08-05",
			"2026-05-31",
			"20-269685",
		]) {
			assert.ok(detail.includes(fact), `missing: ${fact}`);
		}
		assert.equal(/https?:\/\//.test(detail), false);
	});

	test("licensee and DBA are bound in one clause, in that order", () => {
		// The 2026-W33 re-run inverted these when they were two adjacent sentences,
		// publishing "LATIMEX MARKET, doing business as STOOPS, JEFFREY D". Gate 1
		// cannot catch it — both names are in the corpus, only the relationship is
		// wrong — so the corpus must not permit the reading in the first place.
		const detail = licenseEventDetail(META) ?? "";
		assert.match(
			detail,
			/Licensee: STOOPS, JEFFREY D, doing business as LATIMEX MARKET\./,
		);
		assert.doesNotMatch(
			detail,
			/LATIMEX MARKET, doing business as/,
			"the business must never be rendered as operating under the person",
		);
		// The licensee must precede the DBA in the text, not merely coexist with it.
		assert.ok(
			detail.indexOf("STOOPS, JEFFREY D") < detail.indexOf("LATIMEX MARKET"),
		);
	});

	test("a licensee with no DBA renders alone, without a dangling clause", () => {
		const detail = licenseEventDetail({ ...META, dba: "" }) ?? "";
		assert.match(detail, /Licensee: STOOPS, JEFFREY D\./);
		assert.doesNotMatch(detail, /doing business as/i);
	});

	test("a DBA with no licensee is a labelled field, not a floating verb phrase", () => {
		const detail = licenseEventDetail({ ...META, primary_name: "" }) ?? "";
		assert.match(detail, /Doing business as: LATIMEX MARKET\./);
		assert.doesNotMatch(detail, /Licensee:/);
	});

	test("new-application reports are labeled as such", () => {
		const detail = licenseEventDetail({
			...META,
			report_type: "new_applications",
		});
		assert.ok(detail?.includes("new-applications report"));
		assert.equal(detail?.includes("status-change"), false);
	});

	test("empty or fact-free meta returns null", () => {
		assert.equal(licenseEventDetail({}), null);
		assert.equal(
			licenseEventDetail({ attempted_detail_url: "https://x.example" }),
			null,
		);
	});
});
