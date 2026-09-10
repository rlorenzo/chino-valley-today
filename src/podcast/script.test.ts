import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BriefEventAhead } from "../pipeline/posts.ts";
import { pacificDay } from "./inputs.ts";
import {
	buildPodcastBundle,
	composeTranscript,
	eventLine,
	parseTurns,
	podcastChecks,
	spokenText,
} from "./script.ts";

const MONDAY = pacificDay("2026-09-07");
const A = "https://chinovalley.today/posts/a/";
const B = "https://chinovalley.today/posts/b/";

function turn(host: string, text: string, url = A): string {
	return `**${host}:** ${text} [source](${url})`;
}

// A minimally valid draft: three sections in order, alternating hosts, every
// turn cited, and padded to clear the 600-word floor.
function validDraft(padWords = 700): string {
	const pad = Array.from({ length: padWords }, () => "word").join(" ");
	return [
		"## Cold open",
		"",
		turn("Maya", "The council approved the contract on September 8."),
		"",
		turn("Dan", `The district met Thursday. ${pad}`, B),
		"",
		"## Last week",
		"",
		turn("Maya", "The sheriff's station said the road reopened."),
		"",
		"## Week ahead",
		"",
		turn("Dan", "The commission meets at 6:00 PM.", B),
	].join("\n");
}

describe("spokenText", () => {
	test("drops the host label, the citation, and collapsed whitespace", () => {
		assert.equal(
			spokenText("**Maya:** The vote   was 4-1. [source](https://x.test/a)"),
			"The vote was 4-1.",
		);
	});

	test("accepts a turn already stripped of its host label", () => {
		// The audio renderer hands it the other half; both must work.
		assert.equal(
			spokenText("Just words. [source](https://x.test/a)"),
			"Just words.",
		);
	});
});

describe("parseTurns", () => {
	test("attributes each turn to the heading above it", () => {
		const turns = parseTurns(validDraft(0));
		assert.deepEqual(
			turns.map((t) => [t.section, t.host]),
			[
				["Cold open", "Maya"],
				["Cold open", "Dan"],
				["Last week", "Maya"],
				["Week ahead", "Dan"],
			],
		);
	});

	test("collects every citation URL on a turn", () => {
		const turns = parseTurns(
			`## Cold open\n\n**Maya:** Two links. [source](${A}) [also](${B})`,
		);
		assert.deepEqual(turns[0].urls, [A, B]);
	});

	test("ignores lines that are not turns", () => {
		assert.equal(parseTurns("## Cold open\n\nJust some prose.\n").length, 0);
	});
});

describe("podcastChecks", () => {
	test("passes a well-formed draft", () => {
		assert.deepEqual(podcastChecks(validDraft()), []);
	});

	test("rejects the same host speaking twice in a row", () => {
		const failures = podcastChecks(
			validDraft().replace(
				"**Dan:** The commission",
				"**Maya:** The commission",
			),
		);
		assert.equal(failures.length, 1);
		assert.match(failures[0].detail, /alternate/);
	});

	test("rejects a section with no turns", () => {
		const failures = podcastChecks(
			validDraft().replace(/\*\*Dan:\*\* The commission.*$/m, ""),
		);
		assert.equal(failures.length, 1);
		assert.match(failures[0].detail, /"## Week ahead" has no turns/);
	});

	test("rejects a turn whose citation is not one trailing link", () => {
		const noLink = validDraft().replace(` [source](${A})`, "");
		assert.match(podcastChecks(noLink)[0].detail, /exactly one/);
		const midLink = validDraft().replace(
			"The sheriff's station said",
			`The [sheriff](${A}) said`,
		);
		assert.match(podcastChecks(midLink)[0].detail, /exactly one/);
	});

	test("rejects a line that is neither a heading nor a host turn", () => {
		const failures = podcastChecks(
			validDraft().replace("## Last week", "## Last week\n\nA stray line."),
		);
		assert.equal(failures.length, 1);
		assert.match(failures[0].detail, /host turn/);
		assert.equal(failures[0].excerpt, "A stray line.");
	});

	test("rejects a host speaking as someone other than Maya or Dan", () => {
		const failures = podcastChecks(
			validDraft().replace("**Maya:** The sheriff", "**Sam:** The sheriff"),
		);
		assert.ok(failures.some((f) => /host turn/.test(f.detail)));
	});

	test("rejects a turn that ends in a question", () => {
		const failures = podcastChecks(
			validDraft().replace(
				"The commission meets at 6:00 PM.",
				"When does the commission meet?",
			),
		);
		assert.equal(failures.length, 1);
		assert.match(failures[0].detail, /asks the other a question/);
	});

	test("a question mark inside a turn is fine; only the ending matters", () => {
		assert.deepEqual(
			podcastChecks(
				validDraft().replace(
					"The commission meets at 6:00 PM.",
					'The item is titled "What now?" on the agenda.',
				),
			),
			[],
		);
	});

	test("rejects headings that are missing, renamed, or out of order", () => {
		for (const bad of [
			validDraft().replace("## Week ahead", "## The week ahead"),
			validDraft().replace("## Last week", "## Cold open"),
			validDraft().replace("## Cold open\n", ""),
		]) {
			assert.ok(
				podcastChecks(bad).some((f) =>
					/sections must be exactly/.test(f.detail),
				),
			);
		}
	});

	test("rejects a draft that is too short or too long", () => {
		const short = podcastChecks(validDraft(10));
		assert.equal(short.length, 1);
		assert.match(short[0].detail, /between 600 and 1300/);
		assert.match(
			podcastChecks(validDraft(2000))[0].detail,
			/between 600 and 1300/,
		);
	});

	test("counts spoken words only, never the citation URLs", () => {
		// validDraft(n) speaks n padding words plus 25 of prose, across four
		// turns. At n=574 that is 599 spoken words — one short — and the four
		// citations would push it over the floor if links were counted.
		assert.match(podcastChecks(validDraft(574))[0].detail, /is 599 words/);
		assert.deepEqual(podcastChecks(validDraft(575)), []);
	});

	test("caps the stray-line failures a garbage draft produces", () => {
		const garbage = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(
			"\n\n",
		);
		assert.ok(podcastChecks(garbage).length <= 7);
	});
});

describe("composeTranscript", () => {
	const out = composeTranscript(validDraft(), MONDAY);

	test("opens on Cold open with the fixed intro before the generated turns", () => {
		assert.ok(
			out.startsWith("## Cold open\n\n**Maya:** Good morning, and welcome"),
		);
		assert.ok(
			out.indexOf("I'm Maya.") <
				out.indexOf("The council approved the contract"),
		);
	});

	test("dates the intro with the episode Monday", () => {
		assert.match(out, /It's Monday, September 7, 2026\./);
	});

	test("appends the sign-off as its own last section", () => {
		assert.match(out, /## Sign-off\n\n\*\*Maya:\*\* That's the week\./);
		assert.match(out, /Thanks for listening\.\n$/);
	});

	test("keeps every generated turn", () => {
		const before = parseTurns(validDraft()).length;
		// Four fixed turns are added: two intro, two sign-off.
		assert.equal(parseTurns(out).length, before + 4);
	});

	test("throws rather than publish a transcript with no cold open", () => {
		assert.throws(
			() => composeTranscript("## Last week\n\n**Maya:** Hi.", MONDAY),
			/no "## Cold open" heading/,
		);
	});
});

describe("buildPodcastBundle", () => {
	const event: BriefEventAhead = {
		date: "2026-09-08",
		time: "6:00 PM",
		title: "City Council",
		venue: "City Hall",
		url: "https://chino.gov/events/1",
	};
	const inputs = {
		posts: [
			{
				slug: "a",
				title: "Council approves contract",
				url: A,
				publishedAt: "2026-09-03T14:00:00.000Z",
				bodyMd: "The vote was 4-1.",
			},
		],
		events: [event],
	};

	test("keys on the episode's ISO week and Monday", () => {
		const b = buildPodcastBundle(inputs, MONDAY);
		assert.equal(b.targetKey, "podcast:2026-W37");
		assert.equal(b.meetingDate, "2026-09-07");
		assert.equal(b.sourceKey, "podcast");
	});

	test("allows exactly the post and event URLs, deduped", () => {
		const b = buildPodcastBundle(
			{ ...inputs, events: [event, { ...event, title: "Again" }] },
			MONDAY,
		);
		assert.deepEqual(b.allowedUrls, [A, event.url]);
	});

	test("traces the fixed intro and outro, so an echo of them is not a hallucination", () => {
		const b = buildPodcastBundle(inputs, MONDAY);
		for (const s of [
			"Maya",
			"Dan",
			"Chino Valley Today",
			"Week in Review",
			"Monday, September 7, 2026",
			"Thanks for listening",
		]) {
			assert.ok(b.inputCorpus.includes(s), `corpus is missing ${s}`);
		}
	});

	test("carries the source bodies, which is what the numbers are traced against", () => {
		assert.match(buildPodcastBundle(inputs, MONDAY).inputCorpus, /4-1/);
	});
});

describe("eventLine", () => {
	test("omits the fields the calendar does not have", () => {
		assert.equal(
			eventLine({
				date: "2026-09-08",
				time: null,
				title: "Labor Day",
				venue: null,
				url: "https://x.test/e",
			}),
			"2026-09-08",
		);
	});

	test("names who a folded holiday closure closes", () => {
		assert.equal(
			eventLine({
				date: "2026-09-07",
				time: null,
				title: "Labor Day",
				venue: null,
				url: "https://x.test/e",
				closed: [
					{ label: "City of Chino", url: "https://x.test/e" },
					{ label: "CVUSD", url: "https://x.test/f" },
				],
			}),
			"2026-09-07 Closed: City of Chino, CVUSD.",
		);
	});
});
