import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { selectElectionResults } from "../pipeline/daily-brief.ts";
import type { ItemRow } from "../tiera/queries.ts";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import rovResults, { parseRovResults } from "./rov-results.ts";

const html = readFileSync(
	join(import.meta.dirname, "__fixtures__/rov-results.html"),
	"utf8",
);

test("parseRovResults keeps only our contests, most votes first", () => {
	const results = parseRovResults(html);
	assert.ok(results);
	assert.equal(results.electionDate, "2026-11-03");
	assert.equal(results.report, "Summary Report #5");
	assert.deepEqual(
		results.contests.map((c) => c.name),
		[
			"City of Chino Member, City Council District 3",
			"City of Chino Hills MEASURE J",
		],
	);
	assert.deepEqual(results.contests[1].choices, [
		{ name: "NO", votes: 8365, percent: "50.32%" },
		{ name: "YES", votes: 8260, percent: "49.68%" },
	]);
});

test("parseRovResults refuses a page it does not recognize", () => {
	assert.equal(parseRovResults("<html><title>Oops</title></html>"), null);
});

test("parseRovResults refuses a contest with no vote rows", () => {
	const noRows = html.replace(
		/(<table id="electionContests(?!Unresolved)[^>]*>)[\s\S]*?(<\/table>)/g,
		"$1$2",
	);
	assert.equal(parseRovResults(noRows), null);
});

test("parseRovResults refuses an unreadable vote count", () => {
	assert.equal(parseRovResults(html.replace("8,365", "n/a")), null);
});

test("run stores what the brief and results page read", async () => {
	const url = "https://results.rov.sbcounty.gov/";
	const { ctx, items } = fakeScraperContext({ [url]: html });
	await rovResults.run(ctx);

	const measure = items.find((i) => i.title?.endsWith("MEASURE J"));
	assert.equal(items.length, 2);
	assert.equal(measure?.item_type, "election_result");
	assert.equal(
		measure?.external_id,
		"2026-11-03:City of Chino Hills MEASURE J",
	);
	assert.equal(measure?.occurred_at, "2026-11-03T00:00:00.000Z");
	assert.equal(measure?.body, "NO 8,365 (50.32%), YES 8,260 (49.68%)");
	assert.deepEqual(measure?.meta, {
		report: "Summary Report #5",
		status: "Final Unofficial Election Night Results",
		choices: [
			{ name: "NO", votes: 8365, percent: "50.32%" },
			{ name: "YES", votes: 8260, percent: "49.68%" },
		],
	});
});

test("selectElectionResults stops at the certification deadline", () => {
	const item = {
		title: "x",
		occurred_at: "2026-11-03T00:00:00.000Z",
	} as ItemRow;
	assert.equal(
		selectElectionResults([item], new Date("2026-11-06T14:00:00Z")).length,
		1,
	);
	assert.equal(
		selectElectionResults([item], new Date("2026-12-04T00:00:00Z")).length,
		0,
	);
	assert.equal(
		selectElectionResults([item], new Date("2026-11-02T00:00:00Z")).length,
		0,
	);
});
