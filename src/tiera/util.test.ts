import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alertAdvisoryKey, dedupeAlertIssuances } from "./util.ts";

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
