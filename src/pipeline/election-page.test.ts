import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ItemRow } from "../tiera/queries.ts";
import { nextElectionPage, writeElectionPages } from "./election-page.ts";

const item = (title: string, votes: number, report = "Summary Report #5") =>
	({
		title,
		source_url: "https://results.rov.sbcounty.gov/",
		occurred_at: "2026-11-03T00:00:00.000Z",
		meta: JSON.stringify({
			report,
			status: "Final Unofficial Election Night Results",
			choices: [{ name: "YES", votes, percent: "100.00%" }],
		}),
	}) as ItemRow;

const day1 = new Date("2026-11-07T13:50:00.000Z");
const dayAt = (days: number) =>
	new Date(day1.getTime() + days * 24 * 3_600_000);

test("groups by body, offices before measures", () => {
	const page = nextElectionPage(
		[
			item("Chino Valley Unified School District Member, Area 3", 1),
			item("City of Chino MEASURE F", 2),
			item("City of Chino Member, City Council District 2", 3),
			item("City of Chino Hills MEASURE J", 4),
		],
		null,
		day1,
	);
	assert.deepEqual(
		page?.contests.map((c) => [c.group, c.name]),
		[
			["City of Chino Hills", "MEASURE J"],
			["City of Chino", "Member, City Council District 2"],
			["City of Chino", "MEASURE F"],
			["Chino Valley Unified School District", "Member, Area 3"],
		],
	);
	assert.equal(page?.election_date, "2026-11-03");
});

test("revises only for a change, and no more than weekly", () => {
	const title = "City of Chino MEASURE F";
	const first = nextElectionPage([item(title, 1)], null, day1);
	assert.ok(first);

	// New counts inside the week wait, even when reported by a new report.
	const newer = [item(title, 2, "Summary Report #6")];
	assert.equal(nextElectionPage(newer, first, dayAt(3)), null);

	// A week on, with the same counts, there is still nothing to say.
	assert.equal(
		nextElectionPage([item(title, 1, "Summary Report #6")], first, dayAt(7)),
		null,
	);

	const second = nextElectionPage(newer, first, dayAt(7));
	assert.equal(second?.report, "Summary Report #6");
	assert.deepEqual(
		second?.history.map((h) => h.report),
		["Summary Report #5", "Summary Report #6"],
	);
});

test("writeElectionPages leaves the file alone when nothing moved", () => {
	const dir = mkdtempSync(join(tmpdir(), "cvt-elections-"));
	try {
		const items = [item("City of Chino MEASURE F", 1)];
		assert.deepEqual(writeElectionPages(items, dir, day1), ["2026-11-03"]);
		const path = join(dir, "2026-11-03.json");
		const before = readFileSync(path, "utf8");
		assert.deepEqual(writeElectionPages(items, dir, dayAt(7)), []);
		assert.equal(readFileSync(path, "utf8"), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
