import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { QUIET_IS_HEALTHY } from "./quiet-policy.ts";
import { SCRAPERS } from "./registry.ts";

describe("QUIET_IS_HEALTHY", () => {
	// The point of the map is that it is exhaustive. A scraper added to the
	// registry without an entry here would be watched by the 3-failures rule but
	// not by the 0-items rule, which is the half chinohills-swagit slipped
	// through — so the omission has to fail a test, not a code review.
	test("declares every registry source, and only those", () => {
		assert.deepEqual(
			Object.keys(QUIET_IS_HEALTHY).sort(),
			Object.keys(SCRAPERS).sort(),
		);
	});

	test("a quiet-is-healthy source states why", () => {
		for (const [key, reason] of Object.entries(QUIET_IS_HEALTHY)) {
			if (reason === null) continue;
			assert.ok(
				reason.trim().length > 20,
				`${key}: the reason quiet is expected must be a sentence an operator can act on, not a placeholder`,
			);
		}
	});
});
