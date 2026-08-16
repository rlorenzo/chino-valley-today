import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { idSlug, meetingScopedId } from "./external-id.ts";

// external_id is half of item identity — insertItem resolves an item as
// (document url, item_type, external_id) — so two genuinely different items
// sharing one external_id can merge into a single row.

describe("idSlug", () => {
	test("lowercases and reduces to a safe id fragment", () => {
		assert.equal(
			idSlug("Community Services Commission"),
			"community-services-commission",
		);
		assert.equal(idSlug("Regular"), "regular");
	});

	test("collapses punctuation runs and trims edge separators", () => {
		assert.equal(
			idSlug("Parks & Recreation  Commission"),
			"parks-recreation-commission",
		);
		assert.equal(idSlug("  Special  "), "special");
		assert.equal(idSlug("--Organizational--"), "organizational");
	});

	test("keeps digits, which appear in real body names", () => {
		assert.equal(idSlug("District 3 Committee"), "district-3-committee");
	});
});

describe("meetingScopedId", () => {
	test("two meetings on the SAME DATE get different ids", () => {
		// The whole point. cvusd-board holds Regular, Special and Organizational
		// meetings; a bare `<date>-<n>` made item 1 of each collide, and the
		// url-scoped identity lookup would then merge them into one item.
		const regular = meetingScopedId("2026-07-16", "Regular", 1);
		const special = meetingScopedId("2026-07-16", "Special", 1);
		assert.notEqual(regular, special);
		assert.equal(regular, "2026-07-16-regular-1");
		assert.equal(special, "2026-07-16-special-1");
	});

	test("two commissions on the same date get different ids", () => {
		// chino-agendacenter carries a separate agenda series per commission.
		assert.notEqual(
			meetingScopedId("2022-01-04", "Community Services Commission", 1),
			meetingScopedId("2022-01-04", "Planning Commission", 1),
		);
	});

	test("the same meeting and item is stable across runs", () => {
		// Identity must not drift, or every re-scrape inserts a new row.
		assert.equal(
			meetingScopedId("2026-07-16", "Regular", 1),
			meetingScopedId("2026-07-16", "Regular", 1),
		);
	});

	test("different items within one meeting stay distinct", () => {
		assert.notEqual(
			meetingScopedId("2026-07-16", "Regular", 1),
			meetingScopedId("2026-07-16", "Regular", 2),
		);
	});

	test("a string suffix works for meeting-level ids", () => {
		assert.equal(
			meetingScopedId("2026-07-16", "Regular", "meeting"),
			"2026-07-16-regular-meeting",
		);
	});

	test("a missing discriminator falls back to the bare date, never 'undefined'", () => {
		// Baking the literal string "undefined" into a stored identity would be
		// worse than the collision it was meant to prevent.
		assert.equal(meetingScopedId("2026-07-16", null, 1), "2026-07-16-1");
		assert.equal(meetingScopedId("2026-07-16", undefined, 1), "2026-07-16-1");
		assert.equal(meetingScopedId("2026-07-16", "", 1), "2026-07-16-1");
		assert.equal(meetingScopedId("2026-07-16", "   ", 1), "2026-07-16-1");
	});
});
