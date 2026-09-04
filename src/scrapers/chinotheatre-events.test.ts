import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import scraper, {
	parsePerformances,
	parseSeasonYear,
	performanceToItem,
} from "./chinotheatre-events.ts";

const SEASON_URL =
	"https://sites.google.com/view/chinocommunitytheatre/2026-season";

const FIXTURE = readFileSync(
	join(import.meta.dirname, "__fixtures__/chinotheatre-season.html"),
	"utf8",
);

function must<T>(value: T | undefined): T {
	assert.ok(value !== undefined);
	return value;
}

describe("parseSeasonYear", () => {
	test("reads the year out of the page <title>", () => {
		assert.equal(parseSeasonYear(FIXTURE), 2026);
	});

	test("returns null rather than guessing when there is no season title", () => {
		assert.equal(
			parseSeasonYear("<title>Chino Community Theatre</title>"),
			null,
		);
		assert.equal(parseSeasonYear("<title></title>"), null);
	});
});

describe("parsePerformances", () => {
	const perfs = parsePerformances(FIXTURE, 2026);

	test("expands every date on the fixture into its own performance", () => {
		// Ghost Train: 6 evening + 4 matinee = 10. Full Monty: 6 evening (one
		// line crosses April -> May) + 4 matinee = 10. Diary of Anne Frank: 6
		// evening (crosses Sept -> Oct) + 4 matinee = 10. 30 total.
		assert.equal(perfs.length, 30);
	});

	test("attributes each performance to the correct show title", () => {
		const byTitle = new Map<string, number>();
		for (const p of perfs)
			byTitle.set(p.title, (byTitle.get(p.title) ?? 0) + 1);
		assert.deepEqual(Object.fromEntries(byTitle), {
			"THE GHOST TRAIN": 10,
			"THE FULL MONTY": 10,
			"THE DIARY OF ANNE FRANK": 10,
		});
	});

	test("parses the full-month-name + 'at' format", () => {
		const first = perfs.find((p) => p.title === "THE GHOST TRAIN");
		assert.deepEqual(first, {
			title: "THE GHOST TRAIN",
			year: 2026,
			month: "January",
			day: 16,
			timeText: "7:30 PM",
		});
	});

	test("parses the abbreviated-month + '@' format", () => {
		const matinee = perfs.find(
			(p) =>
				p.title === "THE DIARY OF ANNE FRANK" &&
				p.timeText === "2:30 PM" &&
				p.day === 20,
		);
		assert.deepEqual(matinee, {
			title: "THE DIARY OF ANNE FRANK",
			year: 2026,
			month: "September",
			day: 20,
			timeText: "2:30 PM",
		});
	});

	test("carries a date list across a month boundary in one clause", () => {
		const monty = perfs.filter(
			(p) => p.title === "THE FULL MONTY" && p.timeText === "7:30 PM",
		);
		const months = monty.map((p) => `${p.month} ${p.day}`);
		assert.deepEqual(months, [
			"April 17",
			"April 18",
			"April 24",
			"April 25",
			"May 1",
			"May 2",
		]);

		const diary = perfs.filter(
			(p) => p.title === "THE DIARY OF ANNE FRANK" && p.timeText === "7:30 PM",
		);
		assert.deepEqual(
			diary.map((p) => `${p.month} ${p.day}`),
			[
				"September 18",
				"September 19",
				"September 25",
				"September 26",
				"October 2",
				"October 3",
			],
		);
	});

	test("does not mistake the bold, non-italic AUDIENCE ADVISORY paragraph for a new title", () => {
		// If it did, Full Monty's date lines would end up orphaned (no current
		// title) or attached to "AUDIENCE ADVISORY:" instead.
		const advisory = perfs.filter((p) => p.title === "AUDIENCE ADVISORY:");
		assert.equal(advisory.length, 0);
		assert.equal(perfs.filter((p) => p.title === "THE FULL MONTY").length, 10);
	});

	test("resolves an abbreviated month by prefix, however it is written", () => {
		// The fixture only carries "Sept"; "Sep." is the same month, and a
		// two-letter stub is too ambiguous to guess at.
		const title =
			'<p><span style="font-style:italic;font-weight:700">A SHOW</span></p>';
		assert.equal(
			parsePerformances(`${title}<p>Sep. 18, 19 at 7:30pm</p>`, 2026)[0]?.month,
			"September",
		);
		assert.deepEqual(
			parsePerformances(`${title}<p>Ju 18, 19 at 7:30pm</p>`, 2026),
			[],
		);
	});

	test("returns nothing rather than throwing when the markup has no recognizable shows", () => {
		assert.deepEqual(parsePerformances("<p>hello</p>", 2026), []);
		assert.deepEqual(parsePerformances("", 2026), []);
	});
});

describe("performanceToItem", () => {
	const perfs = parsePerformances(FIXTURE, 2026);

	test("converts LA wall-clock time to a correct UTC instant (PST, January)", () => {
		const p = must(
			perfs.find((p) => p.title === "THE GHOST TRAIN" && p.day === 16),
		);
		// 7:30 PM PST on 2026-01-16 is 03:30 UTC the next day (UTC-8 in January).
		assert.equal(performanceToItem(p)?.occurred_at, "2026-01-17T03:30:00.000Z");
	});

	test("converts LA wall-clock time to a correct UTC instant (PDT, September)", () => {
		const p = must(
			perfs.find(
				(p) =>
					p.title === "THE DIARY OF ANNE FRANK" &&
					p.day === 18 &&
					p.month === "September",
			),
		);
		// 7:30 PM PDT on 2026-09-18 is 02:30 UTC the next day (UTC-7 in September).
		assert.equal(performanceToItem(p)?.occurred_at, "2026-09-19T02:30:00.000Z");
	});

	test("gives every performance a unique, stable external_id", () => {
		const ids = perfs.map((p) => performanceToItem(p)?.external_id);
		assert.equal(new Set(ids).size, ids.length);
	});

	test("keeps two performances of the same show on the same date distinct (a double-header day)", () => {
		// Ghost Train runs an evening AND a matinee on Jan 24 -- same date,
		// different time, so external_id must not collide.
		const evening = must(
			perfs.find(
				(p) =>
					p.title === "THE GHOST TRAIN" &&
					p.day === 24 &&
					p.timeText === "7:30 PM",
			),
		);
		const matinee = must(
			perfs.find(
				(p) =>
					p.title === "THE GHOST TRAIN" &&
					p.day === 24 &&
					p.timeText === "2:30 PM",
			),
		);
		const a = performanceToItem(evening)?.external_id;
		const b = performanceToItem(matinee)?.external_id;
		assert.ok(a && b);
		assert.notEqual(a, b);
		assert.equal(a, "2026-01-24-1930-the-ghost-train");
		assert.equal(b, "2026-01-24-1430-the-ghost-train");
	});

	test("sets item_type, title, and meta on the produced item", () => {
		const p = must(
			perfs.find((p) => p.title === "THE GHOST TRAIN" && p.day === 16),
		);
		const item = performanceToItem(p);
		assert.equal(item?.item_type, "event");
		assert.equal(item?.title, "THE GHOST TRAIN");
		assert.deepEqual(item?.meta, {
			host: "chinocommunitytheatre.org",
			venue: "Chino Community Theatre",
			allDay: false,
			showTitle: "THE GHOST TRAIN",
		});
	});
});

describe("run", () => {
	test("stores every performance on the season page", async () => {
		const { ctx, items, notes } = fakeScraperContext({ [SEASON_URL]: FIXTURE });
		await scraper.run(ctx);
		assert.equal(items.length, 30);
		assert.equal(new Set(items.map((i) => i.external_id)).size, 30);
		assert.ok(notes.some((n) => n.includes("stored 30 of 30")));
		assert.ok(notes.some((n) => n.includes("season year 2026")));
	});

	test("throws when the season year is gone rather than guessing one", async () => {
		// A wrong year is silent and would misdate a whole season, so the
		// missing marker has to fail the run outright.
		const { ctx, items } = fakeScraperContext({
			[SEASON_URL]: FIXTURE.replace(
				/<title>[^<]*<\/title>/,
				"<title>Home</title>",
			),
		});
		await assert.rejects(() => scraper.run(ctx), /"<year> Season" marker/);
		assert.equal(items.length, 0);
	});

	test("throws when the page parses but yields no performances", async () => {
		const { ctx } = fakeScraperContext({
			[SEASON_URL]:
				"<title>Chino Community Theatre - 2026 Season</title><p>TBA</p>",
		});
		await assert.rejects(() => scraper.run(ctx), /No performances parsed/);
	});
});
