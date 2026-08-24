import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pacificDay, schoolYearStart } from "./school-year.ts";

describe("pacificDay", () => {
	it("reports the school's calendar day, not UTC's", () => {
		// 23:30 PST is already the next day at UTC. A UTC-sliced day would shift
		// every date window forward every evening.
		assert.equal(
			pacificDay(new Date("2026-11-10T23:30:00-08:00")),
			"2026-11-10",
		);
	});

	it("zero-pads to YYYY-MM-DD", () => {
		assert.equal(
			pacificDay(new Date("2026-01-05T12:00:00-08:00")),
			"2026-01-05",
		);
	});

	it("is built from named parts, not from the locale's string order", () => {
		// en-CA printing YYYY-MM-DD is locale data, not a spec guarantee, and
		// schoolYearStart slices fixed positions out of this.
		assert.match(
			pacificDay(new Date("2026-08-23T12:00:00Z")),
			/^\d{4}-\d{2}-\d{2}$/,
		);
	});

	it("reports the Pacific day, not the UTC one, on a west-of-UTC evening", () => {
		// 2026-07-01T02:00Z is still June 30 in California — the evening that
		// would otherwise roll the season over a day early.
		assert.equal(pacificDay(new Date("2026-07-01T02:00:00Z")), "2026-06-30");
	});
});

describe("schoolYearStart", () => {
	it("refuses anything that is not YYYY-MM-DD", () => {
		// Unguarded, positional slicing turns these into "NaN", and a scraper
		// then asks its source for the NaN season — which both athletics
		// sources answer with an empty table, so the run reports success having
		// ingested nothing.
		for (const bad of ["", "abcd", "2026", "26-08-23", "2026/08/23"]) {
			assert.throws(
				() => schoolYearStart(bad),
				/expected YYYY-MM-DD/,
				`${JSON.stringify(bad)} should be refused`,
			);
		}
	});

	it("names the year the season starts in", () => {
		// July through December belong to the season that just began.
		assert.equal(schoolYearStart("2026-07-01"), "2026");
		assert.equal(schoolYearStart("2026-11-10"), "2026");
		assert.equal(schoolYearStart("2026-12-31"), "2026");
	});

	it("keeps the spring half of the season on its start year", () => {
		assert.equal(schoolYearStart("2027-01-01"), "2026");
		assert.equal(schoolYearStart("2027-06-30"), "2026");
	});

	it("rolls over on July 1, not on January 1", () => {
		assert.equal(schoolYearStart("2026-06-30"), "2025");
		assert.equal(schoolYearStart("2026-07-01"), "2026");
	});
});
