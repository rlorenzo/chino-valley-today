import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import scraper, {
	eventToItem,
	extractTime,
	normalizeDateText,
	parseEvents,
} from "./planesoffame-events.ts";

const LISTING_URL = "https://planesoffame.org/events-calendar";

const FIXTURE = readFileSync(
	join(import.meta.dirname, "__fixtures__/planesoffame-events.html"),
	"utf8",
);

describe("normalizeDateText", () => {
	test("rewrites the listing's ordinal header into a parseable date", () => {
		// cheerio's .text() has already flattened "5<sup>th</sup>" to "5th".
		assert.equal(
			normalizeDateText("5th of September, 2026"),
			"September 5, 2026",
		);
		assert.equal(
			normalizeDateText("1st of December, 2026"),
			"December 1, 2026",
		);
		assert.equal(
			normalizeDateText("  22nd   of   October,  2027 "),
			"October 22, 2027",
		);
	});

	test("returns null for anything that is not a date header", () => {
		assert.equal(normalizeDateText("Read More »"), null);
		assert.equal(normalizeDateText(""), null);
	});
});

describe("extractTime", () => {
	test("recovers the start time from body prose", () => {
		assert.equal(
			extractTime('P-51D "Mustang"; Saturday, September 5, 2026 at 10:30am.'),
			"10:30 AM",
		);
		assert.equal(extractTime("Gates open at 9am."), "9:00 AM");
		assert.equal(extractTime("Doors at 7:15 p.m."), "7:15 PM");
	});

	test("returns null when the prose carries no time", () => {
		assert.equal(extractTime("An action-packed weekend of warbirds."), null);
		assert.equal(extractTime(null), null);
	});

	test("ignores an out-of-range hour rather than inventing one", () => {
		assert.equal(extractTime("at 19:00pm"), null);
	});
});

describe("parseEvents", () => {
	const events = parseEvents(FIXTURE);

	test("finds every event block in the real listing markup", () => {
		assert.equal(events.length, 2);
	});

	test("parses the on-site event with its date, time and permalink", () => {
		const e = events[0];
		assert.equal(e.dateText, "September 5, 2026");
		assert.equal(e.timeText, "10:30 AM");
		assert.equal(
			e.url,
			"https://planesoffame.org/events-calendar2/Hangar-Talk-8",
		);
		assert.equal(e.offsite, false);
		assert.match(e.title, /Commemorative Air Force B-17G/);
	});

	test("flags an appearance at another venue as off-site", () => {
		const e = events[1];
		assert.equal(e.offsite, true);
		assert.equal(e.dateText, "September 12, 2026");
		assert.match(e.url, /centralcoastairfest\.com/);
	});

	test("returns nothing rather than throwing when the markup changes", () => {
		assert.deepEqual(parseEvents("<div class='something-else'>hi</div>"), []);
	});
});

describe("eventToItem", () => {
	const [onsite, offsite] = parseEvents(FIXTURE);

	test("converts the LA wall-clock time to a correct UTC instant", () => {
		// 10:30 AM PDT on 2026-09-05 is 17:30 UTC (UTC-7 in September).
		assert.equal(eventToItem(onsite)?.occurred_at, "2026-09-05T17:30:00.000Z");
	});

	test("keys the on-site event on the CMS permalink slug, date-prefixed", () => {
		assert.equal(eventToItem(onsite)?.external_id, "2026-09-05-hangar-talk-8");
	});

	test("stores the venue and clears allDay when a time was found", () => {
		const meta = eventToItem(onsite)?.meta as Record<string, unknown>;
		assert.equal(meta.venue, "Planes of Fame Air Museum");
		assert.equal(meta.allDay, false);
		assert.equal(meta.offsite, false);
	});

	test("falls back to the title for an off-site event and marks it all-day", () => {
		const item = eventToItem(offsite);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.offsite, true);
		assert.equal(meta.venue, null);
		assert.equal(meta.allDay, true);
		// No permalink slug to key on, so the id comes from the title.
		assert.match(item?.external_id ?? "", /^2026-09-12-central-coast-airfest/);
	});

	test("two events on one date get distinct identities", () => {
		const a = eventToItem(onsite)?.external_id;
		const b = eventToItem({ ...onsite, title: "Something else" })?.external_id;
		// Same permalink means genuinely the same event, so these SHOULD match;
		// the discriminator that matters is the slug, not the title.
		assert.equal(a, b);
		const c = eventToItem({
			...onsite,
			url: "https://planesoffame.org/events-calendar2/Hangar-Talk-9",
		})?.external_id;
		assert.notEqual(a, c);
	});

	test("returns null for an unparseable date rather than storing a half-item", () => {
		assert.equal(eventToItem({ ...onsite, dateText: "sometime soon" }), null);
	});
});

describe("run", () => {
	test("stores every parsed block, off-site ones included", async () => {
		const { ctx, items, notes } = fakeScraperContext({
			[LISTING_URL]: FIXTURE,
		});
		await scraper.run(ctx);
		assert.equal(items.length, 2);
		// Off-site appearances are archived here and filtered later, in the
		// brief's Today section, off meta.offsite.
		assert.equal(
			items.filter((i) => (i.meta as { offsite?: boolean }).offsite).length,
			1,
		);
		assert.ok(notes.some((n) => n.includes("stored 2 of 2")));
	});

	test("throws when the listing markup moves, rather than reporting a quiet day", async () => {
		// This calendar is never legitimately empty, so zero parsed blocks means
		// the selectors broke — a failed run, not a day with no events.
		const { ctx, items } = fakeScraperContext({
			[LISTING_URL]:
				"<html><body><div class='redesigned'>Events</div></body></html>",
		});
		await assert.rejects(() => scraper.run(ctx), /No parsable event blocks/);
		assert.equal(items.length, 0);
	});

	test("skips an undated block with a note instead of failing the run", async () => {
		const broken = FIXTURE.replace(
			"5<sup>th</sup> of September, 2026",
			"Coming soon",
		);
		const { ctx, items, notes } = fakeScraperContext({ [LISTING_URL]: broken });
		await scraper.run(ctx);
		// The undated block is dropped by parseEvents itself (no date header, no
		// event), leaving the off-site one.
		assert.equal(items.length, 1);
		assert.ok(notes.some((n) => n.includes("stored 1 of 1")));
	});
});
