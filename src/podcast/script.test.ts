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
	podcastPromptBody,
	podcastRepairGuidance,
	podcastSystem,
	spokenText,
} from "./script.ts";

const MONDAY = pacificDay("2026-09-07");
const A = "https://chinovalley.today/posts/a/";
const B = "https://chinovalley.today/posts/b/";

function turn(host: string, text: string, url = A): string {
	return `**${host}:** ${text} [source](${url})`;
}

// A minimally valid draft: both sections in order, alternating hosts, every
// turn cited, and padded to clear the 600-word floor. No opening section —
// composeTranscript adds that, and the model never writes it.
function validDraft(padWords = 700): string {
	const pad = Array.from({ length: padWords }, () => "word").join(" ");
	return [
		"## Last week",
		"",
		turn("Maya", "The council approved the contract on September 8."),
		"",
		turn("Dan", `The district met Thursday. ${pad}`, B),
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
				["Last week", "Maya"],
				["Last week", "Dan"],
				["Last week", "Maya"],
				["Week ahead", "Dan"],
			],
		);
	});

	test("collects every citation URL on a turn", () => {
		const turns = parseTurns(
			`## Last week\n\n**Maya:** Two links. [source](${A}) [also](${B})`,
		);
		assert.deepEqual(turns[0].urls, [A, B]);
	});

	test("ignores lines that are not turns", () => {
		assert.equal(parseTurns("## Last week\n\nJust some prose.\n").length, 0);
	});
});

describe("podcastChecks", () => {
	test("the spoken-length floor is the caller's, so a thin week can be short", () => {
		const short = [
			"## Last week",
			"",
			"**Maya:** One thing happened this week. [s](https://example.com/a)",
			"",
			"**Dan:** The council met on Tuesday. [s](https://example.com/a)",
			"",
			"## Week ahead",
			"",
			"**Maya:** The commission meets Wednesday. [s](https://example.com/a)",
		].join("\n");
		const lengthFailure = (min?: number) =>
			podcastChecks(short, min).filter((f) =>
				f.detail.includes("spoken length"),
			);
		// Default floor rejects it; a thin week's floor of 1 accepts it.
		assert.equal(lengthFailure().length, 1);
		assert.equal(lengthFailure(1).length, 0);
	});

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
			validDraft().replace("## Last week\n", ""),
			// The opening is fixed text the model must not write for itself.
			`## Opening\n\n${validDraft()}`,
		]) {
			assert.ok(
				podcastChecks(bad).some((f) =>
					/sections must be exactly/.test(f.detail),
				),
			);
		}
	});

	test("rejects a turn that cites a preview and says the meeting happened", () => {
		// Purpose-built rather than a mutated validDraft: its other turns already
		// say "approved" and "met", so mutating it cannot tell which turn tripped.
		const draft = (claim: string) =>
			[
				"## Last week",
				"",
				`**Maya:** ${claim} [source](${B})`,
				"",
				"## Week ahead",
				"",
				turn("Dan", "The commission meets at 6:00 PM.", A),
			].join("\n");
		const previews = new Set([B]);
		const previewFailures = (md: string, p = previews) =>
			podcastChecks(md, 0, p).filter((f) => /PREVIEW/.test(f.detail));

		assert.match(
			previewFailures(
				draft("The Board of Education held a regular meeting on September 17."),
			)[0]?.detail ?? "",
			/cites a meeting PREVIEW and says "held"/,
		);
		// The same sentence is fine when the cited post is not a preview...
		assert.equal(
			previewFailures(
				draft("The Board of Education held a regular meeting on September 17."),
				new Set(),
			).length,
			0,
		);
		// ...and a preview turn that stays in the future is fine too.
		assert.equal(
			previewFailures(
				draft("The Board of Education is scheduled to meet on September 17."),
			).length,
			0,
		);
		// The future PASSIVE uses the same participles and is equally correct.
		for (const future of [
			"The meeting is scheduled to be held on Thursday.",
			"The bond item will be discussed on Thursday.",
			"The appeal is scheduled to be heard Thursday.",
			// One adverb between the auxiliary and the participle is still future.
			"The proposal will be formally discussed on Thursday.",
			"The appeal is scheduled to be publicly heard on Thursday.",
			"The council is scheduled to formally approve it Thursday.",
		]) {
			assert.equal(previewFailures(draft(future)).length, 0, future);
		}
		// Perfect and past passive still assert the thing happened.
		for (const past of [
			"The meeting was held on Thursday.",
			"The bond item has been approved.",
		]) {
			assert.equal(previewFailures(draft(past)).length, 1, past);
		}
		// A valid future clause does not launder an unsupported past claim in the
		// same turn.
		assert.match(
			previewFailures(
				draft(
					"The bond item will be discussed Thursday, and the board approved it.",
				),
			)[0]?.detail ?? "",
			/cites a meeting PREVIEW and says "approved"/,
		);
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

describe("thin-week prompts", () => {
	// The floor only works if generation and repair are told the same number the
	// check enforces: a prompt still demanding 900-1100 words, or a repair still
	// forbidding anything under 600, is an instruction to pad.
	test("generation and repair carry the caller's floor and no full-week target", () => {
		const system = podcastSystem(250);
		const repair = podcastRepairGuidance(250);
		for (const text of [system, repair]) {
			assert.match(text, /250/);
			assert.doesNotMatch(text, /900|1100|600/);
		}
	});

	test("a full week keeps the target and the 600-word floor", () => {
		assert.match(podcastSystem(), /900 to 1100 words/);
		assert.match(podcastRepairGuidance(), /below 600 spoken words/);
	});
});

describe("composeTranscript", () => {
	const out = composeTranscript(validDraft(), MONDAY);

	test("opens on Opening with the fixed intro before the generated turns", () => {
		assert.ok(
			out.startsWith("## Opening\n\n**Maya:** Good morning, and welcome"),
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

	test("composing an already-composed transcript changes nothing", () => {
		// The audio-promote failure path holds the post with the composed
		// transcript in its body; the resume run composes whatever is on disk.
		assert.equal(composeTranscript(out, MONDAY), out);
		assert.equal(
			parseTurns(composeTranscript(out, MONDAY)).length,
			parseTurns(out).length,
		);
	});

	test("throws rather than publish a draft that does not open on Last week", () => {
		assert.throws(
			() => composeTranscript("## Week ahead\n\n**Maya:** Hi.", MONDAY),
			/does not open on "## Last week"/,
		);
	});

	test("adds the crisis line, and only when the episode raised it", () => {
		assert.ok(!out.includes("988"));
		const sensitive = composeTranscript(
			validDraft().replace(
				"The sheriff's station said the road reopened.",
				"A Suicide Prevention Awareness event is scheduled Thursday.",
			),
			MONDAY,
		);
		assert.match(sensitive, /988 Suicide and Crisis Lifeline/);
		// Still alternating across the seam the extra turn creates.
		const hosts = parseTurns(sensitive)
			.filter((t) => t.section === "Sign-off")
			.map((t) => t.host);
		assert.deepEqual(hosts, ["Maya", "Dan", "Maya"]);
		// And composing it again must not speak it twice.
		assert.equal(composeTranscript(sensitive, MONDAY), sensitive);
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
				postType: "meeting_recap",
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

	test("drops the pipeline's notes about its own reach", () => {
		// On the page this note explains a thin preview honestly. Read aloud it is
		// a machine discussing robots.txt with someone in their car, and W39 did
		// exactly that. It is also not a fact about Chino Valley, so it must not be
		// in the corpus that decides what a turn may say.
		const withNote = {
			...inputs,
			posts: [
				{
					...inputs.posts[0],
					bodyMd:
						"The vote was 4-1.\n\n_No agenda item text is in our records for this meeting — CVUSD's agenda PDF host currently blocks automated fetching (robots.txt)._",
				},
			],
		};
		const corpus = buildPodcastBundle(withNote, MONDAY).inputCorpus;
		assert.ok(!corpus.includes("robots.txt"));
		assert.ok(!corpus.includes("in our records"));
		assert.match(corpus, /4-1/); // the real content survives
		assert.ok(!podcastPromptBody(withNote, MONDAY).includes("robots.txt"));
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
