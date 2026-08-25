import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import chinoHighScraper from "./chinohigh-sports.ts";
import {
	citationFor,
	type HomeCampusSchool,
	isPlayed,
	parseSportSlugs,
	rowToItem,
	runHomeCampusSports,
	sportSlugCandidate,
	titleFor,
} from "./homecampus-sports.ts";

const HOST = "www.chinohighathletics.com";

const NAV = `
<a href="https://www.chinohighathletics.com/varsity/football/schedule-results">Schedule</a>
<a href="https://www.chinohighathletics.com/varsity/water-polo-boys/schedule-results">Schedule</a>
<a href="https://www.chinohighathletics.com/varsity/swimming-diving-boys-3/schedule-results">Schedule</a>
<a href="https://www.chinohighathletics.com/varsity/golf-boys/schedule-results">Schedule</a>
`;

describe("parseSportSlugs", () => {
	it("reads the per-sport schedule links out of the nav", () => {
		const slugs = parseSportSlugs(NAV, HOST);
		assert.equal(slugs.size, 4);
		assert.equal(
			slugs.get("football"),
			"https://www.chinohighathletics.com/varsity/football/schedule-results",
		);
	});

	it("returns an empty map rather than throwing on markup with no nav", () => {
		assert.equal(
			parseSportSlugs("<html><body>nothing</body></html>", HOST).size,
			0,
		);
	});
});

describe("sportSlugCandidate", () => {
	it("drops a parenthesised variant that is not part of the slug", () => {
		// The live case: the API says "Football (11 person)", the site says
		// /varsity/football/.
		assert.equal(sportSlugCandidate("Football (11 person)"), "football");
	});

	it("normalises punctuation the way the site does", () => {
		assert.equal(sportSlugCandidate("Water Polo, Boys"), "water-polo-boys");
		assert.equal(
			sportSlugCandidate("Swimming & Diving, Boys"),
			"swimming-diving-boys",
		);
	});
});

describe("citationFor", () => {
	const slugs = parseSportSlugs(NAV, HOST);

	it("cites the sport's own page when the nav has it", () => {
		assert.equal(
			citationFor("Water Polo, Boys", slugs, HOST),
			"https://www.chinohighathletics.com/varsity/water-polo-boys/schedule-results",
		);
	});

	it("matches a numeric disambiguator suffix", () => {
		// The live oddity: /varsity/swimming-diving-boys-3/, which no derivation
		// rule would predict.
		assert.equal(
			citationFor("Swimming & Diving, Boys", slugs, HOST),
			"https://www.chinohighathletics.com/varsity/swimming-diving-boys-3/schedule-results",
		);
	});

	it("does not match a longer slug that merely starts the same", () => {
		// "golf-boys" must never resolve to a "golf-boys-and-girls" page: that is
		// a different team, and a confidently wrong citation is the worst kind.
		const trap = parseSportSlugs(
			'<a href="https://www.chinohighathletics.com/varsity/golf-boys-and-girls/schedule-results">x</a>',
			HOST,
		);
		assert.equal(
			citationFor("Golf, Boys", trap, HOST),
			"https://www.chinohighathletics.com/schedule/",
		);
	});

	it("falls back to the schedule index rather than inventing a URL", () => {
		assert.equal(
			citationFor("Kabaddi", slugs, HOST),
			"https://www.chinohighathletics.com/schedule/",
		);
		assert.equal(
			citationFor("", slugs, HOST),
			"https://www.chinohighathletics.com/schedule/",
		);
	});
});

describe("titleFor", () => {
	it("leads with the winner's score on a win", () => {
		assert.equal(
			titleFor({
				sport: "Football (11 person)",
				level: "Varsity",
				school: "Chino",
				opponent: "Ontario Christian",
				result: "W",
				score: "20",
				opponent_score: "14",
			}),
			"Varsity Football (11 person): Chino def. Ontario Christian, 20-14",
		);
	});

	it("leads with the winner's score on a loss too", () => {
		// The reader-facing bug this guards: "Chino lost to Colony, 8-10" reads
		// as though the larger number were ours.
		assert.equal(
			titleFor({
				sport: "Tennis, Girls",
				level: "Varsity",
				school: "Chino",
				opponent: "Colony",
				result: "L",
				score: "8",
				opponent_score: "10",
			}),
			"Varsity Tennis, Girls: Chino lost to Colony, 10-8",
		);
	});

	it("says vs at home and at away for an unplayed game", () => {
		const base = {
			sport: "Volleyball, Girls",
			level: "Varsity",
			school: "Chino",
			opponent: "Walnut",
		};
		assert.match(
			titleFor({ ...base, location: "Home" }) ?? "",
			/Chino vs Walnut$/,
		);
		assert.match(
			titleFor({ ...base, location: "Away" }) ?? "",
			/Chino at Walnut$/,
		);
	});

	it("calls a tie a tie rather than dressing it as a fixture", () => {
		assert.equal(
			titleFor({
				sport: "Soccer, Boys",
				level: "Varsity",
				school: "Chino",
				opponent: "Colony",
				result: "T",
				score: "2",
				opponent_score: "2",
			}),
			"Varsity Soccer, Boys: Chino tied Colony, 2-2",
		);
	});

	it("does not pin a verb or a score to an unrecognised result letter", () => {
		// Better a plain fixture line than a confident sentence built on a code
		// whose meaning we are guessing at. meta.result keeps the raw letter.
		assert.equal(
			titleFor({
				sport: "Baseball",
				level: "Varsity",
				school: "Chino",
				opponent: "Walnut",
				result: "D",
				score: "2",
				opponent_score: "2",
				location: "Home",
			}),
			"Varsity Baseball: Chino vs Walnut",
		);
	});

	it("un-inverts an opponent named after a person", () => {
		// "Chino def. King, Martin Luther, 3-1" reads as though we named a person
		// and reported their score — which the team-level rule exists to prevent.
		assert.equal(
			titleFor({
				sport: "Water Polo, Boys",
				level: "Varsity",
				school: "Chino",
				opponent: "Ayala, Ruben",
				result: "W",
				score: "3",
				opponent_score: "1",
			}),
			"Varsity Water Polo, Boys: Chino def. Ruben Ayala, 3-1",
		);
	});

	it("returns null when the row names no opponent or sport", () => {
		assert.equal(titleFor({ sport: "Baseball", school: "Chino" }), null);
		assert.equal(titleFor({ school: "Chino", opponent: "Walnut" }), null);
	});

	it("treats a partial score as unplayed rather than reporting half a result", () => {
		const t = titleFor({
			sport: "Baseball",
			level: "Varsity",
			school: "Chino",
			opponent: "Walnut",
			result: "W",
			score: "5",
			opponent_score: "",
			location: "Home",
		});
		assert.equal(t, "Varsity Baseball: Chino vs Walnut");
	});
});

describe("isPlayed", () => {
	it("requires all three of score, opponent score and result", () => {
		const full = { score: "20", opponent_score: "14", result: "W" };
		assert.equal(isPlayed(full), true);
		assert.equal(isPlayed({ ...full, opponent_score: "" }), false);
		assert.equal(isPlayed({ ...full, score: "" }), false);
		assert.equal(isPlayed({ ...full, result: "" }), false);
		assert.equal(isPlayed({}), false);
	});
});

describe("isPlayed and the stored result agree", () => {
	const base = {
		id: 1,
		date: "2026-08-21",
		sport: "Baseball",
		level: "Varsity",
		school: "Chino",
		opponent: "Walnut",
		location: "Home",
		score: "5",
		opponent_score: "3",
	};

	it("does not store a result for a letter it cannot name", () => {
		// Title and meta used to disagree: any non-empty letter counted as
		// played, while the title only rendered W/L/T. A row with result "D"
		// produced a line reading as an unplayed fixture beside meta claiming a
		// final score, which a roundup would have published as a result.
		const item = rowToItem({ ...base, result: "D" }, 7, "https://x.example/p");
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.played, false);
		assert.equal(meta.result, null);
		assert.equal(meta.score, null);
		assert.match(item?.title ?? "", /Chino vs Walnut$/);
	});

	it("still stores a result it can name", () => {
		const item = rowToItem({ ...base, result: "W" }, 7, "https://x.example/p");
		const meta = item?.meta as Record<string, unknown>;
		assert.equal(meta.played, true);
		assert.equal(meta.result, "W");
		assert.equal(meta.score, "5");
	});
});

describe("rowToItem", () => {
	const CITE =
		"https://www.chinohighathletics.com/varsity/football/schedule-results";

	const PLAYED = {
		id: 3705040,
		date: "2026-08-21",
		sport: "Football (11 person)",
		sport_id: 255,
		level: "Varsity",
		school: "Chino",
		school_id: 103,
		opponent: "Ontario Christian",
		event_type: "Game",
		game_type: "Non-League",
		location: "Home",
		result: "W",
		score: "20",
		opponent_score: "14",
		formatted_time: "07:00 PM",
	};

	it("keys identity on the platform id, so a reschedule updates in place", () => {
		const item = rowToItem(PLAYED, 7, CITE);
		assert.equal(item?.external_id, "3705040");
		// One type for played and unplayed alike — see the note in the module.
		assert.equal(item?.item_type, "game");
	});

	it("cites the human page, never the API", () => {
		const item = rowToItem(PLAYED, 7, CITE);
		assert.equal(item?.source_url, CITE);
		assert.doesNotMatch(item?.source_url ?? "", /wp-json/);
	});

	it("carries the score in meta and marks the game played", () => {
		const meta = rowToItem(PLAYED, 7, CITE)?.meta as Record<string, unknown>;
		assert.equal(meta.played, true);
		assert.equal(meta.score, "20");
		assert.equal(meta.opponentScore, "14");
		assert.equal(meta.result, "W");
	});

	it("nulls the score fields on an unplayed game rather than storing empties", () => {
		const meta = rowToItem(
			{ ...PLAYED, result: "", score: "", opponent_score: "" },
			7,
			CITE,
		)?.meta as Record<string, unknown>;
		assert.equal(meta.played, false);
		assert.equal(meta.score, null);
		assert.equal(meta.result, null);
	});

	it("stores the readable form of an opponent named after a person", () => {
		const meta = rowToItem({ ...PLAYED, opponent: "Ayala, Ruben" }, 7, CITE)
			?.meta as Record<string, unknown>;
		assert.equal(meta.opponent, "Ruben Ayala");
	});

	it("flags a TBA opponent so a roundup can skip it", () => {
		const meta = rowToItem({ ...PLAYED, opponent: "TBA" }, 7, CITE)
			?.meta as Record<string, unknown>;
		assert.equal(meta.opponentTbd, true);
		const named = rowToItem(PLAYED, 7, CITE)?.meta as Record<string, unknown>;
		assert.equal(named.opponentTbd, false);
	});

	it("stores a bare local date, not an invented instant", () => {
		// The API gives a school-day date and a wall-clock time with no zone.
		assert.equal(rowToItem(PLAYED, 7, CITE)?.occurred_at, "2026-08-21");
	});

	it("never ingests result_remark", () => {
		// Free text about a high school game is exactly where a minor's name
		// would appear, and EDITORIAL.md's interim rule is team-level only.
		const withRemark = {
			...PLAYED,
			result_remark: "Hat trick from #12 Jordan Smith",
		};
		const serialised = JSON.stringify(rowToItem(withRemark, 7, CITE));
		assert.doesNotMatch(serialised, /Jordan Smith/);
		assert.doesNotMatch(serialised, /result_remark|resultRemark/);
	});

	it("drops rows with no id or no usable date", () => {
		assert.equal(rowToItem({ ...PLAYED, id: undefined }, 7, CITE), null);
		assert.equal(rowToItem({ ...PLAYED, date: "not-a-date" }, 7, CITE), null);
		assert.equal(rowToItem({ ...PLAYED, date: undefined }, 7, CITE), null);
	});
});

describe("runHomeCampusSports", () => {
	const SCHOOL: HomeCampusSchool = {
		key: "chinohigh-sports",
		name: "Chino High School Athletics (scores and schedules)",
		host: HOST,
		schoolId: 103,
		label: "Chino High School",
	};
	const HOME = `https://${HOST}/`;
	const API = `https://${HOST}/wp-json/sports/v1/main-teams`;
	// A November evening in Pacific time that is already the next day at UTC —
	// the case the window and the season year have to get right.
	const NOW = new Date("2026-11-10T23:30:00-08:00");

	const row = (over: Record<string, unknown> = {}) => ({
		id: 3705040,
		date: "2026-11-07",
		sport: "Football (11 person)",
		level: "Varsity",
		school: "Chino",
		school_id: 103,
		opponent: "Ontario Christian",
		location: "Home",
		...over,
	});

	const envelope = (...rows: object[]) =>
		JSON.stringify({ success: true, data: { data: { schedules: rows } } });

	/** The POST body of the first fetchDocument call; empty if none was made. */
	const requestBody = (documents: { meta: { jsonBody?: unknown } }[]) =>
		(documents[0]?.meta.jsonBody ?? {}) as Record<string, unknown>;

	it("asks for one Pacific-anchored window, as a POST for this school only", async () => {
		const { ctx, documents } = fakeScraperContext({
			[HOME]: NAV,
			[API]: envelope(row()),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		const body = requestBody(documents);
		assert.equal(documents[0]?.url, API);
		// Pacific, not UTC: at 23:30 PST it is already 2026-11-11 in UTC, and a
		// UTC-sliced window would silently shift a day every evening.
		assert.equal(body.date_from, "2026-10-27");
		assert.equal(body.date_to, "2026-12-01");
		assert.equal(body.school_id, "103");
		// November is in the 2026-27 season, which the API names by its start year.
		assert.equal(body.year, "2026");
		// One request, not seventeen paginated ones, for a volunteer host to serve.
		assert.equal(body.per_page, 100);
	});

	it("shifts the window by calendar days, not by fixed 24-hour blocks", async () => {
		// NOW's lookback crosses the November DST change. Shifting the instant by
		// 14 x 86_400_000 ms lands an hour past midnight on the far side of it and
		// reports 2026-10-28, losing a day off the edge of the window.
		const { ctx, documents } = fakeScraperContext({
			[HOME]: NAV,
			[API]: envelope(),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		assert.equal(requestBody(documents).date_from, "2026-10-27");
	});

	it("reads the season year off the Pacific date at the July rollover", async () => {
		// 2026-06-30 17:00 PDT is 2026-07-01 UTC: the season must not roll over
		// until the school's own July 1.
		const { ctx, documents } = fakeScraperContext({
			[HOME]: NAV,
			[API]: envelope(),
		});

		await runHomeCampusSports(
			ctx,
			SCHOOL,
			new Date("2026-06-30T17:00:00-07:00"),
		);

		assert.equal(requestBody(documents).year, "2025");
	});

	it("cites the sport's own page from the nav, never the API", async () => {
		const { ctx, items } = fakeScraperContext({
			[HOME]: NAV,
			[API]: envelope(row()),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		assert.equal(items.length, 1);
		assert.equal(
			items[0].source_url,
			`https://${HOST}/varsity/football/schedule-results`,
		);
	});

	it("keeps going when the nav throws, citing the schedule index", async () => {
		const { ctx, items, notes } = fakeScraperContext({
			[HOME]: new Error("connect ECONNREFUSED"),
			[API]: envelope(row()),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		assert.equal(items[0]?.source_url, `https://${HOST}/schedule/`);
		assert.ok(
			notes.some((n) => /could not be fetched/.test(n)),
			`expected a fetch-failure note, got: ${notes.join(" | ")}`,
		);
	});

	it("blames the response, not the markup, when the nav 404s", async () => {
		// fetchRaw resolves on a non-2xx rather than throwing, so this used to
		// land on "no per-sport links found" — reporting our own failed request
		// as the school's markup being empty.
		const { ctx, items, notes } = fakeScraperContext({
			[HOME]: { status: 404 },
			[API]: envelope(row()),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		assert.equal(items[0]?.source_url, `https://${HOST}/schedule/`);
		assert.ok(
			notes.some((n) => /answered HTTP 404/.test(n)),
			`expected an HTTP-status note, got: ${notes.join(" | ")}`,
		);
		assert.ok(
			!notes.some((n) => /carried no per-sport links/.test(n)),
			"a failed fetch must not be reported as empty markup",
		);
	});

	it("says the nav was empty when it really was", async () => {
		const { ctx, items, notes } = fakeScraperContext({
			[HOME]: "<html><body>no links here</body></html>",
			[API]: envelope(row()),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		assert.equal(items[0]?.source_url, `https://${HOST}/schedule/`);
		assert.ok(
			notes.some((n) => /carried no per-sport links/.test(n)),
			`expected an empty-nav note, got: ${notes.join(" | ")}`,
		);
	});

	it("ignores rows belonging to another school", async () => {
		// The response is a platform-wide table filtered by request; a row for
		// school 28 arriving on school 103's request must not be filed here.
		const { ctx, items } = fakeScraperContext({
			[HOME]: NAV,
			[API]: envelope(row(), row({ id: 999, school_id: 28 })),
		});

		await runHomeCampusSports(ctx, SCHOOL, NOW);

		assert.deepEqual(
			items.map((i) => i.external_id),
			["3705040"],
		);
	});

	it("fails the run when the envelope shape moves, instead of ingesting nothing quietly", async () => {
		// An empty ingest and a renamed field look identical from the outside —
		// and out of season, an empty ingest is normal. Only a throw separates
		// them, because run-one.ts reads a run's status from whether run() threw.
		const { ctx } = fakeScraperContext({
			[HOME]: NAV,
			[API]: JSON.stringify({ success: true, data: { rows: [] } }),
		});

		await assert.rejects(
			() => runHomeCampusSports(ctx, SCHOOL, NOW),
			/did not contain data\.data\.schedules/,
		);
	});

	it("fails the run on a non-JSON response", async () => {
		const { ctx } = fakeScraperContext({
			[HOME]: NAV,
			[API]: "<html>maintenance</html>",
		});

		await assert.rejects(
			() => runHomeCampusSports(ctx, SCHOOL, NOW),
			/not JSON/,
		);
	});
});

describe("homeCampusScraper", () => {
	it("derives the base URL and fetch allow-list from the one host", () => {
		// The point of the factory: the host cannot drift between the three
		// places a hand-written def would have repeated it.
		assert.equal(chinoHighScraper.key, "chinohigh-sports");
		assert.equal(chinoHighScraper.baseUrl, `https://${HOST}`);
		assert.deepEqual(chinoHighScraper.fetchDefaults?.allowedHosts, [HOST]);
	});
});
