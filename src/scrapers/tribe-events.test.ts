import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type TribeEvent,
	tribeEventToItem,
	tribeUtcToIso,
} from "./tribe-events.ts";

// Trimmed from a real library.sbcounty.gov API response (2026-08-17).
const FIXTURE: TribeEvent = {
	id: 10015532,
	url: "https://library.sbcounty.gov/event/tails-and-stories-loma-linda/2026-08-16/",
	title: "Tails and Stories &#8211; Read Aloud",
	description: "<p>Read aloud to therapy dogs.</p>",
	utc_start_date: "2026-08-16 21:00:00",
	utc_end_date: "2026-08-16 22:00:00",
	all_day: false,
	cost: "",
	venue: { id: 1181, venue: "Chino Branch Library" },
	categories: [{ name: "Kids Zone (6-11 years)" }, {}],
};

describe("tribeUtcToIso", () => {
	test("converts the API's space-separated UTC datetime to an ISO instant", () => {
		assert.equal(
			tribeUtcToIso("2026-08-16 21:00:00"),
			"2026-08-16T21:00:00.000Z",
		);
	});
	test("returns null on missing or malformed input", () => {
		assert.equal(tribeUtcToIso(undefined), null);
		assert.equal(tribeUtcToIso("not a date"), null);
	});
});

describe("tribeEventToItem", () => {
	const item = tribeEventToItem(FIXTURE, "library.sbcounty.gov");

	test("cites the event permalink and derives an occurrence-safe external_id", () => {
		assert.equal(item.source_url, FIXTURE.url);
		assert.equal(item.external_id, "10015532:2026-08-16 21:00:00");
		assert.equal(item.item_type, "event");
	});

	test("decodes entities in the title and strips markup from the body", () => {
		assert.equal(item.title, "Tails and Stories – Read Aloud");
		assert.equal(item.body, "Read aloud to therapy dogs.");
	});

	test("occurred_at is the UTC start instant", () => {
		assert.equal(item.occurred_at, "2026-08-16T21:00:00.000Z");
	});

	test("meta carries venue, categories (nameless entries dropped), and end", () => {
		const meta = item.meta as Record<string, unknown>;
		assert.equal(meta.venue, "Chino Branch Library");
		assert.equal(meta.venueId, 1181);
		assert.deepEqual(meta.categories, ["Kids Zone (6-11 years)"]);
		assert.equal(meta.endUtc, "2026-08-16T22:00:00.000Z");
		assert.equal(meta.cost, null); // empty string normalized
		assert.equal(meta.allDay, false);
	});

	test("venue label falls back to config when the API omits venue", () => {
		const bare = tribeEventToItem(
			{ ...FIXTURE, venue: undefined },
			"cbwcd.org",
			"CBWCD",
		);
		assert.equal((bare.meta as Record<string, unknown>).venue, "CBWCD");
	});
});
