import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	alertAdvisoryKey,
	alertEventKey,
	alertPostSlug,
	alertPostSlugHash,
	alertPostSlugHashOf,
	dedupeAlertIssuances,
	dropSupersededAlerts,
} from "./util.ts";

// NWS re-issues an advisory as a series of Updates: same event, same end
// time, same area, a new id each time. Keyed on the id, one Heat Advisory
// re-issued three times became three "Active alert" lines in the brief and
// three near-identical published posts.
const HEAT = {
	event: "Heat Advisory",
	ends: "2026-08-20T20:00:00-07:00",
	areaDesc: "San Bernardino and Riverside County Valleys-The Inland Empire",
};

function issuance(id: number, effective: string, over: object = {}) {
	return {
		id,
		external_id: `urn:oid:2.49.0.1.840.0.${id}`,
		source_url: `https://api.weather.gov/alerts/${id}`,
		meta: JSON.stringify({
			...HEAT,
			messageType: "Update",
			effective,
			...over,
		}),
	};
}

describe("alert advisory dedupe", () => {
	test("three re-issuances of one advisory collapse to one", () => {
		const rows = [
			issuance(1, "2026-08-18T11:56:00-07:00"),
			issuance(2, "2026-08-18T20:47:00-07:00"),
			issuance(3, "2026-08-19T00:58:00-07:00"),
		];
		const out = dedupeAlertIssuances(rows);
		assert.equal(out.length, 1);
		// The EARLIEST survives: the alert post's slug derives from the row
		// that lives, so keeping the first issuance resolves a re-issue to the
		// post that already exists rather than minting a fourth one.
		assert.equal(out[0].id, 1);
	});

	test("an advisory whose end time actually moved is a different advisory", () => {
		// An Update that extends the heat is news; it must not be swallowed.
		const rows = [
			issuance(1, "2026-08-18T11:56:00-07:00"),
			issuance(2, "2026-08-19T00:58:00-07:00", {
				ends: "2026-08-21T20:00:00-07:00",
			}),
		];
		assert.equal(dedupeAlertIssuances(rows).length, 2);
	});

	test("different events on the same day stay separate", () => {
		const rows = [
			issuance(1, "2026-08-18T11:56:00-07:00"),
			issuance(2, "2026-08-18T12:00:00-07:00", { event: "Red Flag Warning" }),
		];
		assert.equal(dedupeAlertIssuances(rows).length, 2);
	});

	test("rows missing the identifying fields never merge", () => {
		// Without event/ends there is nothing to collapse on, and merging two
		// unrelated alerts would drop a real one. Fall back to the issuance.
		const bare = (id: number) => ({
			id,
			external_id: `x${id}`,
			source_url: `https://example.gov/${id}`,
			meta: JSON.stringify({ severity: "Severe" }),
		});
		assert.equal(dedupeAlertIssuances([bare(1), bare(2)]).length, 2);
		assert.match(alertAdvisoryKey(bare(1)), /^id:/);
	});

	test("unparseable meta is survivable, not fatal", () => {
		const broken = {
			id: 1,
			external_id: "x",
			source_url: "https://example.gov/1",
			meta: "{not json",
		};
		assert.equal(dedupeAlertIssuances([broken]).length, 1);
	});
});

describe("superseded alert suppression", () => {
	test("an extended advisory is one advisory, at its current end time", () => {
		// The 2026-08-22 front page: a Heat Advisory issued 08-21 ending 08-24,
		// and the Update that extended it to 08-25. dedupeAlertIssuances treats
		// those as two advisories, which is right for post identity and wrong
		// for a reader — it says the heat ends a day before it does.
		const rows = [
			issuance(1, "2026-08-21T12:23:00-07:00", {
				ends: "2026-08-24T20:00:00-07:00",
			}),
			issuance(2, "2026-08-22T13:10:00-07:00", {
				ends: "2026-08-25T10:00:00-07:00",
			}),
		];
		const out = dropSupersededAlerts(rows);
		assert.equal(out.length, 1);
		// The NEWEST survives here, unlike dedupeAlertIssuances: the brief
		// states what is in force now, not what a post was first slugged from.
		assert.equal(out[0].id, 2);
	});

	test("a different product is not a duplicate, however much it overlaps", () => {
		// An Extreme Heat Watch running past the advisory is a second warning a
		// reader needs, not a re-issue of the first.
		const rows = [
			issuance(1, "2026-08-22T13:10:00-07:00"),
			issuance(2, "2026-08-22T13:10:00-07:00", {
				event: "Extreme Heat Watch",
				ends: "2026-08-28T20:00:00-07:00",
			}),
		];
		assert.equal(dropSupersededAlerts(rows).length, 2);
	});

	test("the same event in a different area stays separate", () => {
		const rows = [
			issuance(1, "2026-08-22T13:10:00-07:00"),
			issuance(2, "2026-08-22T13:10:00-07:00", {
				areaDesc: "San Diego County Mountains",
			}),
		];
		assert.equal(dropSupersededAlerts(rows).length, 2);
	});

	test("three re-issuances of one advisory still collapse to one", () => {
		const rows = [
			issuance(1, "2026-08-18T11:56:00-07:00"),
			issuance(2, "2026-08-18T20:47:00-07:00"),
			issuance(3, "2026-08-19T00:58:00-07:00"),
		];
		const out = dropSupersededAlerts(rows);
		assert.equal(out.length, 1);
		assert.equal(out[0].id, 3);
	});

	test("without an event name nothing merges", () => {
		const bare = (id: number) => ({
			id,
			external_id: `x${id}`,
			source_url: `https://example.gov/${id}`,
			meta: JSON.stringify({ ends: "2026-08-25T10:00:00-07:00" }),
		});
		assert.equal(dropSupersededAlerts([bare(1), bare(2)]).length, 2);
		assert.match(alertEventKey(bare(1)), /^id:/);
	});

	test("unparseable meta is survivable here too", () => {
		const broken = {
			id: 1,
			external_id: "x",
			source_url: "https://example.gov/1",
			meta: "{not json",
		};
		assert.equal(dropSupersededAlerts([broken]).length, 1);
	});

	test("meta that parses to something other than an object is survivable", () => {
		// "null", "[]" and "\"x\"" all parse cleanly and would have thrown on the
		// property read that follows — parseable is not the same as usable.
		for (const meta of ["null", "[]", '"x"', "7"]) {
			const row = {
				id: 1,
				external_id: "x",
				source_url: "https://example.gov/1",
				meta,
			};
			assert.equal(dropSupersededAlerts([row]).length, 1, meta);
			assert.equal(dedupeAlertIssuances([row]).length, 1, meta);
			assert.match(alertEventKey(row), /^id:/, meta);
		}
	});

	test("issuances are compared as instants, not as strings", () => {
		// The same moment, one written with an offset and one as UTC. Compared
		// instant order and string order disagree here. Row 2 is the later
		// issuance — 14:00-07:00 is 21:00Z, half an hour after row 1's 20:30Z —
		// but as strings "2026-08-22T14..." sorts before "2026-08-22T20...", so
		// a lexicographic compare keeps row 1 and renders the superseded window.
		const rows = [
			issuance(1, "2026-08-22T20:30:00Z", {
				ends: "2026-08-24T20:00:00-07:00",
			}),
			issuance(2, "2026-08-22T14:00:00-07:00", {
				ends: "2026-08-25T10:00:00-07:00",
			}),
		];
		const out = dropSupersededAlerts(rows);
		assert.equal(out.length, 1);
		assert.equal(out[0].id, 2);
	});

	test("an unparseable timestamp falls back to id order, not NaN", () => {
		const rows = [issuance(1, "not a date"), issuance(2, "also not a date")];
		const out = dropSupersededAlerts(rows);
		assert.equal(out.length, 1);
		assert.equal(out[0].id, 2);
	});
});

describe("alert post slugs", () => {
	const row = issuance(7, "2026-08-18T11:56:00-07:00");

	test("the hash rides on the issuance identity, not the title", () => {
		// This is what lets the brief match a post against an "Active alert"
		// line whose title reads differently.
		const a = alertPostSlug("2026-08-22", "Heat Advisory", row);
		const b = alertPostSlug(
			"2026-08-22",
			"Heat Advisory issued August 22",
			row,
		);
		assert.notEqual(a, b, "the title still shapes the readable part");
		assert.equal(alertPostSlugHashOf(a), alertPostSlugHashOf(b));
		assert.notEqual(
			alertPostSlugHash(row),
			alertPostSlugHash(issuance(8, "2026-08-18T11:56:00-07:00")),
			"a genuinely different issuance hashes differently",
		);
	});

	test("falls back to the source url when there is no external id", () => {
		assert.equal(
			alertPostSlugHash({ ...row, external_id: null }).length,
			8,
			"a row without an external id still gets a stable hash",
		);
	});

	test("a built slug round-trips back to its hash", () => {
		// The builder and the parser are the two halves of one format; this is
		// what catches them drifting apart.
		const slug = alertPostSlug("2026-08-22", "Heat Advisory", row);
		assert.equal(
			slug,
			`2026-08-22-heat-advisory-alert-${alertPostSlugHash(row)}`,
		);
		assert.equal(alertPostSlugHashOf(slug), alertPostSlugHash(row));
	});

	test("does not read a hash out of a nixle slug", () => {
		// Nixle posts are alert-typed and end the same shape; the `-alert-`
		// marker is the only thing keeping them out of the brief's join.
		assert.equal(
			alertPostSlugHashOf(
				`2026-08-17-vehicle-theft-nixle-${alertPostSlugHash(row)}`,
			),
			null,
		);
		assert.equal(alertPostSlugHashOf("2026-08-24-chino-preview"), null);
	});
});
