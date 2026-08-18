import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectedBriefSlug, staleHealthText } from "./brief-health.ts";

describe("expectedBriefSlug", () => {
	test("names today's brief by the LA calendar day, not the UTC day", () => {
		// 08:00 PDT on Aug 18 is already Aug 19 in UTC by evening standards —
		// the watchdog must still expect the Aug 18 brief.
		assert.equal(
			expectedBriefSlug(new Date("2026-08-18T15:00:00.000Z")),
			"2026-08-18-daily-brief",
		);
		// 11 PM PDT Aug 18 = Aug 19 UTC: still the Aug 18 brief.
		assert.equal(
			expectedBriefSlug(new Date("2026-08-19T06:00:00.000Z")),
			"2026-08-18-daily-brief",
		);
	});
});

describe("staleHealthText", () => {
	const built = [
		"ok",
		"built=2026-08-18T13:00:00.000Z",
		"posts=10",
		"latest_post=2026-08-17",
		"latest_brief=2026-08-17",
		"pipeline=fresh",
		"",
	].join("\n");

	test("flips fresh to stale and touches nothing else", () => {
		const flipped = staleHealthText(built);
		assert.ok(flipped);
		assert.match(flipped, /^ok\n/);
		assert.match(flipped, /pipeline=stale/);
		assert.doesNotMatch(flipped, /pipeline=fresh/);
		assert.equal(flipped.split("\n").length, built.split("\n").length);
	});

	test("nothing to write when the marker is already stale or absent", () => {
		assert.equal(staleHealthText(built.replace("fresh", "stale")), null);
		assert.equal(staleHealthText("ok\nbuilt=whenever\n"), null);
	});
});
