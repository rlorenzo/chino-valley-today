import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import chinoHillsScraper, {
	chinoHillsSide,
	isoDate,
	parseRows,
	parseSports,
	resolveColumns,
	resultOf,
	rowToItem,
	runChinoHillsSports,
	stripCsrfToken,
	type WidgetRow,
	widgetUrl,
} from "./chinohills-sports.ts";
import { pacificDay, schoolYearStart } from "./school-year.ts";

/** The widget's real shape: 12 cells, the row id carrying the event id. */
const DEFAULT_HEADERS = [
	"Sport",
	"Home",
	"Facility",
	"HomeDivision",
	"Home Score",
	"Away",
	"AwayDivision",
	"Away Score",
	"Date",
	"Time",
	"Game Type",
	"Notes",
];

function widgetHtml(rows: string, headers?: string[]): string {
	return `<html><body>
<select name="sport_id">
  <option value="">Select</option>
  <option value="1">Football (11 person)</option>
  <option value="13">Volleyball, Girls</option>
</select>
<table>
<thead><tr>${(headers ?? DEFAULT_HEADERS).map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

function tr(id: string, cells: string[]): string {
	return `<tr id="${id}">${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}

/** Sport, Home, Facility, HomeDiv, HomeScore, Away, AwayDiv, AwayScore, Date, Time, Type, Notes */
function cells(over: Partial<Record<number, string>> = {}): string[] {
	const base = [
		"Football (11 person)",
		"Quartz Hill",
		"",
		"",
		"15",
		"Chino Hills",
		"",
		"14",
		"08/21/2026",
		"07:00 pm",
		"Non-League",
		"Event Notes",
	];
	for (const [i, v] of Object.entries(over)) base[Number(i)] = v as string;
	return base;
}

const ROW: WidgetRow = {
	eventId: "3757949",
	sport: "Football (11 person)",
	home: "Quartz Hill",
	facility: "",
	homeScore: "15",
	away: "Chino Hills",
	awayScore: "14",
	date: "08/21/2026",
	time: "07:00 pm",
	gameType: "Non-League",
};

const CITE = widgetUrl("1", "2026");

describe("parseSports", () => {
	it("reads the sport list out of the widget's own select", () => {
		const sports = parseSports(widgetHtml(""));
		assert.deepEqual(sports, [
			{ id: "1", name: "Football (11 person)" },
			{ id: "13", name: "Volleyball, Girls" },
		]);
	});

	it("drops the empty placeholder option the widget rejects", () => {
		assert.ok(parseSports(widgetHtml("")).every((s) => s.id !== ""));
	});
});

describe("parseRows", () => {
	it("reads a row and keeps the event id from the tr", () => {
		const rows = parseRows(widgetHtml(tr("3757949", cells())));
		assert.equal(rows.length, 1);
		assert.equal(rows[0].eventId, "3757949");
		assert.equal(rows[0].home, "Quartz Hill");
		assert.equal(rows[0].awayScore, "14");
	});

	it("drops a row with no numeric id rather than deriving one", () => {
		// A derived id would churn whenever the source reformatted a cell, and
		// churn means the same game re-inserted under a new identity.
		const rows = parseRows(widgetHtml(tr("header-row", cells())));
		assert.deepEqual(rows, []);
	});

	it("ignores a row with too few cells to be a fixture", () => {
		assert.deepEqual(parseRows(widgetHtml(tr("1", ["a", "b"]))), []);
	});
});

describe("stripCsrfToken", () => {
	const page = (token: string) =>
		Buffer.from(
			`<form><input type="hidden" name="_token" value="${token}"></form><table></table>`,
			"utf8",
		);

	it("makes two fetches of an unchanged page hash the same", () => {
		// The widget sends cache-control: no-cache with no etag, and mints a
		// fresh Laravel token per request. Without this, every sport's response
		// is a new content hash on every run: 36 document rows and 36
		// raw-archive files a day for pages that have not changed.
		const a = stripCsrfToken(page("6UW2yv365d6r6g9kGb7X8S9tI7j55v1E"));
		const b = stripCsrfToken(page("uqeKXRQ31Kw3LYAmGNN2IeRUI9NDUu5l"));
		assert.equal(a.toString(), b.toString());
	});

	it("removes the token and nothing else", () => {
		const stripped = stripCsrfToken(page("abc123")).toString();
		assert.doesNotMatch(stripped, /abc123/);
		assert.match(stripped, /<table><\/table>/);
		assert.match(stripped, /name="_token"/);
	});

	it("leaves a page with no token byte-identical", () => {
		const plain = Buffer.from('<table><tr id="1"></tr></table>', "utf8");
		assert.equal(stripCsrfToken(plain).toString(), plain.toString());
	});
});

describe("column resolution", () => {
	it("reads columns by header name, not by position", () => {
		// A column dropped upstream shifts every index after it. Positionally,
		// Notes would slide into gameType — free text landing in a stored field
		// precisely because the rule against it was enforced by counting.
		const shifted = DEFAULT_HEADERS.filter((h) => h !== "AwayDivision");
		const cellsNoFacility = cells().filter((_c, i) => i !== 6);
		cellsNoFacility[10] = "Two touchdowns from #7 Jordan Smith"; // Notes, shifted to 10
		const rows = parseRows(widgetHtml(tr("3757949", cellsNoFacility), shifted));
		assert.equal(rows.length, 1);
		assert.equal(rows[0].gameType, "Non-League");
		assert.notEqual(rows[0].gameType, "Two touchdowns from #7 Jordan Smith");
		assert.doesNotMatch(JSON.stringify(rows[0]), /Jordan Smith/);
	});

	it("parses nothing when a column it needs has gone", () => {
		// Loud nothing beats rows parsed against guessed positions.
		const without = DEFAULT_HEADERS.filter((h) => h !== "Away Score");
		assert.deepEqual(parseRows(widgetHtml(tr("1", cells()), without)), []);
	});

	it("resolveColumns returns null when a header is missing", () => {
		assert.equal(
			resolveColumns(
				widgetHtml(
					"",
					DEFAULT_HEADERS.filter((h) => h !== "Date"),
				),
			),
			null,
		);
		assert.ok(resolveColumns(widgetHtml("")));
	});
});

describe("isoDate", () => {
	it("converts the widget's MM/DD/YYYY", () => {
		assert.equal(isoDate("08/21/2026"), "2026-08-21");
	});

	it("returns null on anything else, rather than a wrong date", () => {
		for (const bad of ["", "2026-08-21", "8/21/26", "not a date"]) {
			assert.equal(isoDate(bad), null);
		}
	});
});

describe("chinoHillsSide", () => {
	it("finds us on either side", () => {
		assert.equal(chinoHillsSide(ROW), "away");
		assert.equal(
			chinoHillsSide({ ...ROW, home: "Chino Hills", away: "Quartz Hill" }),
			"home",
		);
	});

	it("does not match a different school whose name starts the same", () => {
		// "Chino Hills Christian" is not us, and reporting their result as ours
		// would be a confidently wrong claim about a real game.
		assert.equal(
			chinoHillsSide({
				...ROW,
				home: "Chino Hills Christian",
				away: "Quartz Hill",
			}),
			null,
		);
	});
});

describe("rowToItem", () => {
	it("reports a loss from our side, winner's score first", () => {
		// Live row: Quartz Hill 15, Chino Hills 14, so this is our loss.
		const item = rowToItem(ROW, 7, CITE);
		assert.equal(
			item?.title,
			"Football (11 person): Chino Hills lost to Quartz Hill, 15-14",
		);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.result, "L");
		assert.equal(meta.score, "14");
		assert.equal(meta.opponentScore, "15");
		assert.equal(meta.location, "Away");
	});

	it("reports a win from our side", () => {
		const item = rowToItem(
			{ ...ROW, homeScore: "10", awayScore: "21" },
			7,
			CITE,
		);
		assert.match(item?.title ?? "", /Chino Hills def\. Quartz Hill, 21-10$/);
	});

	it("calls an equal score a tie rather than a win", () => {
		const item = rowToItem({ ...ROW, homeScore: "2", awayScore: "2" }, 7, CITE);
		assert.match(item?.title ?? "", /tied Quartz Hill, 2-2$/);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.result, "T");
	});

	it("treats one score alone as unplayed", () => {
		// The section mid-entry, not a result.
		const item = rowToItem({ ...ROW, awayScore: "" }, 7, CITE);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.played, false);
		assert.match(item?.title ?? "", /Chino Hills at Quartz Hill$/);
	});

	it("treats a non-numeric score as unplayed rather than a tie", () => {
		// Number("F") is NaN, and NaN is neither greater nor less than NaN, so a
		// forfeit letter left unguarded would be published as "tied 15-F".
		const item = rowToItem({ ...ROW, awayScore: "F" }, 7, CITE);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.played, false);
		assert.equal(meta.result, null);
		assert.equal(meta.score, null);
		assert.match(item?.title ?? "", /Chino Hills at Quartz Hill$/);
	});

	it("says vs for a home fixture and at for an away one", () => {
		const home = rowToItem(
			{
				...ROW,
				home: "Chino Hills",
				away: "Colony",
				homeScore: "",
				awayScore: "",
			},
			7,
			CITE,
		);
		assert.match(home?.title ?? "", /Chino Hills vs Colony$/);
		const meta = home?.meta as Record<string, unknown>;
		assert.equal(meta.location, "Home");
	});

	it("flags a fixture posted before the opponent exists", () => {
		const item = rowToItem(
			{
				...ROW,
				home: "Chino Hills",
				away: "TBA",
				homeScore: "",
				awayScore: "",
			},
			7,
			CITE,
		);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.opponentTbd, true);
	});

	it("drops a row whose date the widget did not print as a date", () => {
		assert.equal(rowToItem({ ...ROW, date: "" }, 7, CITE), null);
	});

	it("un-inverts an opponent named after a person", () => {
		// "Chino Hills def. Ayala, Ruben" reads as though we named a person.
		const item = rowToItem(
			{
				...ROW,
				home: "Chino Hills",
				away: "Ayala, Ruben",
				homeScore: "3",
				awayScore: "1",
			},
			7,
			CITE,
		);
		assert.match(item?.title ?? "", /def\. Ruben Ayala, 3-1$/);
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.opponent, "Ruben Ayala");
	});

	it("keys identity on the section's event id", () => {
		assert.equal(rowToItem(ROW, 7, CITE)?.external_id, "3757949");
		// Same type the Home Campus schools use, so a roundup reads one shape.
		assert.equal(rowToItem(ROW, 7, CITE)?.item_type, "game");
	});

	it("stores a bare local date", () => {
		assert.equal(rowToItem(ROW, 7, CITE)?.occurred_at, "2026-08-21");
	});

	it("never ingests the Notes column", () => {
		// Free text about a high school game is where a minor's name appears.
		const html = widgetHtml(
			tr("3757949", cells({ 11: "Two touchdowns from #7 Jordan Smith" })),
		);
		const parsed = parseRows(html);
		const serialised = JSON.stringify(rowToItem(parsed[0], 7, CITE));
		assert.doesNotMatch(serialised, /Jordan Smith/);
	});

	it("drops a row that is not ours at all", () => {
		assert.equal(
			rowToItem({ ...ROW, home: "Colony", away: "Etiwanda" }, 7, CITE),
			null,
		);
	});
});

describe("resultOf", () => {
	it("reads the outcome from our side", () => {
		assert.equal(resultOf("21", "10"), "W");
		assert.equal(resultOf("10", "21"), "L");
		assert.equal(resultOf("2", "2"), "T");
		assert.equal(resultOf("0", "0"), "T");
	});

	it("refuses anything that is not two whole numbers", () => {
		// A missing half is the section mid-entry; a letter or a dash is not a
		// score at all. Either one compared numerically would report a tie.
		for (const [ours, theirs] of [
			["", "3"],
			["3", ""],
			["", ""],
			["F", "F"],
			["-", "-"],
			["3.5", "2"],
		]) {
			assert.equal(resultOf(ours, theirs), null, `${ours} v ${theirs}`);
		}
	});
});

describe("widgetUrl", () => {
	it("cites a page a reader can actually open, for that school and sport", () => {
		const url = widgetUrl("13", "2026");
		assert.match(
			url,
			/^https:\/\/www\.cifsshome\.org\/widget\/schedule-score\?/,
		);
		assert.match(url, /school_id=104/);
		assert.match(url, /sport_id=13/);
		assert.match(url, /year=2026/);
	});
});

describe("the scraper definition", () => {
	it("pins fetches to the one host it reads", async () => {
		assert.equal(chinoHillsScraper.key, "chinohills-sports");
		assert.equal(chinoHillsScraper.baseUrl, "https://www.cifsshome.org");
		assert.deepEqual(chinoHillsScraper.fetchDefaults?.allowedHosts, [
			"www.cifsshome.org",
		]);
	});

	it("defaults to the current season when the runner supplies no date", async () => {
		// run() is called as (ctx, args) — the date is a test seam, so the
		// wrapper has to fall back to the clock rather than pass args through.
		const year = schoolYearStart(pacificDay(new Date()));
		const { ctx, requested } = fakeScraperContext({
			[widgetUrl("1", year)]: widgetHtml(""),
			[widgetUrl("13", year)]: widgetHtml(""),
		});

		await chinoHillsScraper.run(ctx, []);

		assert.deepEqual(requested, [widgetUrl("1", year), widgetUrl("13", year)]);
	});
});

describe("runChinoHillsSports", () => {
	// A November evening in Pacific time that is already the next day at UTC —
	// the case the season year has to get right.
	const NOW = new Date("2026-11-10T23:30:00-08:00");
	const FOOTBALL = widgetUrl("1", "2026");
	const VOLLEYBALL = widgetUrl("13", "2026");

	/** A fixture row for us, with whatever cells the test wants overridden. */
	const ourRow = (id: string, over: Partial<Record<number, string>> = {}) =>
		tr(id, cells({ 1: "Chino Hills", 5: "Colony", ...over }));

	it("queries every sport the widget lists, one request each", async () => {
		const { ctx, requested } = fakeScraperContext({
			[FOOTBALL]: widgetHtml(""),
			[VOLLEYBALL]: widgetHtml(""),
		});

		await runChinoHillsSports(ctx, NOW);

		// The probe answers for sport 1, so two sports cost two requests, not
		// three: the sport list rides along on the first response.
		assert.deepEqual(requested, [FOOTBALL, VOLLEYBALL]);
	});

	it("reads the season year off the Pacific date at the July rollover", async () => {
		// 2026-06-30 17:00 PDT is 2026-07-01 UTC. The season must not roll over
		// until the school's own July 1, or the widget is asked for a year of
		// games that does not exist yet.
		const url = widgetUrl("1", "2025");
		const { ctx, requested } = fakeScraperContext({
			[url]: widgetHtml(""),
			[widgetUrl("13", "2025")]: widgetHtml(""),
		});

		await runChinoHillsSports(ctx, new Date("2026-06-30T17:00:00-07:00"));

		assert.equal(requested[0], url);
	});

	it("names a sport whose headers will not resolve, rather than reading it as empty", async () => {
		// 36 sports are queried and an out-of-season one legitimately returns
		// nothing, so a rename upstream could empty all of them while the run
		// still reported success.
		const broken = widgetHtml(
			ourRow("3757949"),
			DEFAULT_HEADERS.filter((h) => h !== "Away Score"),
		);
		const { ctx, items, notes } = fakeScraperContext({
			[FOOTBALL]: broken,
			[VOLLEYBALL]: broken,
		});

		await runChinoHillsSports(ctx, NOW);

		assert.deepEqual(items, []);
		assert.ok(
			notes.some((n) => /headers could not be resolved/.test(n)),
			`expected a markup-drift note, got: ${notes.join(" | ")}`,
		);
	});

	it("fails the run when the sport select is gone", async () => {
		// An empty ingest and changed markup look identical from the outside, and
		// between seasons the empty one is normal. The sport list is the widget's
		// own navigation and lists all 36 year-round, so an empty one is broken
		// markup — which has to fail the run, not just note it.
		const { ctx, items, requested } = fakeScraperContext({
			[FOOTBALL]: "<html><body><p>nothing here</p></body></html>",
		});

		await assert.rejects(() => runChinoHillsSports(ctx, NOW), /no sport list/);

		assert.deepEqual(items, []);
		assert.equal(requested.length, 1, "must not sweep 36 sports blind");
	});

	it("cites the widget URL for the sport the row came from", async () => {
		const { ctx, items } = fakeScraperContext({
			[FOOTBALL]: widgetHtml(ourRow("3757949")),
			[VOLLEYBALL]: widgetHtml(
				ourRow("3757950", { 0: "Volleyball, Girls", 8: "09/02/2026" }),
			),
		});

		await runChinoHillsSports(ctx, NOW);

		assert.equal(items.length, 2);
		assert.equal(items[0].source_url, FOOTBALL);
		assert.equal(items[1].source_url, VOLLEYBALL);
		// Each row is attached to the document it was actually read from.
		assert.notEqual(items[0].document_id, items[1].document_id);
	});

	it("titles each archived document with its own sport and year", async () => {
		const { ctx, documents } = fakeScraperContext({
			[FOOTBALL]: widgetHtml(""),
			[VOLLEYBALL]: widgetHtml(""),
		});

		await runChinoHillsSports(ctx, NOW);

		assert.equal(
			documents[0].meta.title,
			"Chino Hills athletics — Football (11 person), 2026",
		);
		assert.equal(
			documents[1].meta.title,
			"Chino Hills athletics — Volleyball, Girls, 2026",
		);
	});

	it("ignores rows for schools that are not us", async () => {
		const { ctx, items, notes } = fakeScraperContext({
			[FOOTBALL]: widgetHtml(
				ourRow("1", { 1: "Colony", 5: "Etiwanda" }) + ourRow("2"),
			),
			[VOLLEYBALL]: widgetHtml(""),
		});

		await runChinoHillsSports(ctx, NOW);

		assert.equal(items.length, 1);
		assert.equal(items[0].external_id, "2");
		assert.ok(
			notes.some((n) => /1 with games -> 1 item\(s\) \(1 played\)/.test(n)),
			`note must count what was stored, got: ${notes.join(" | ")}`,
		);
	});

	it("counts an out-of-season sport as queried but not as having games", async () => {
		const { ctx, notes } = fakeScraperContext({
			[FOOTBALL]: widgetHtml(ourRow("1")),
			[VOLLEYBALL]: widgetHtml(""),
		});

		await runChinoHillsSports(ctx, NOW);

		assert.ok(
			notes.some((n) => /2 sport\(s\) queried for 2026, 1 with games/.test(n)),
			`expected a per-sport tally, got: ${notes.join(" | ")}`,
		);
	});
});
