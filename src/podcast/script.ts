// The weekly podcast's script layer: the fixed intro/outro, the synthesis
// input the generator sees, and the deterministic format checks that decide
// whether what came back is a transcript at all.
//
// The transcript contract is shared with the audio renderer and the site, so
// every rule it states is enforced here rather than merely requested in the
// prompt: a two-host read-aloud script has a shape the gates cannot see (the
// citation validator is happy with a monologue), and an episode is not
// something a reader can skim past a defect in.
import { createHash } from "node:crypto";
import type { GateFailure } from "../gates/validators.ts";
import type { BundleItem, MeetingBundle } from "../pipeline/bundle.ts";
import type { BriefEventAhead } from "../pipeline/posts.ts";
import { isoWeekOf, localMeetingDate } from "../tiera/util.ts";
import type { PodcastInputs, PodcastPost } from "./inputs.ts";

const SHOW_TITLE = "Chino Valley Today, the Week in Review";
const HOSTS = ["Maya", "Dan"] as const;
type Host = (typeof HOSTS)[number];

/** The three generated sections, in the only order they may appear. */
const SECTIONS = ["Cold open", "Last week", "Week ahead"] as const;

/**
 * A turn: one paragraph, one host, one citation. Deliberately strict — the
 * audio renderer splits the episode on exactly this shape, so a turn it cannot
 * parse is a turn nobody voices.
 */
const TURN_RE = /^\*\*(Maya|Dan):\*\* (.+)$/;
const HEADING_RE = /^##\s+(.+)$/;
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]*)\)/g;

/**
 * Not generated. The show says what it is, in the same words, every week —
 * that it is produced automatically and that the voices are synthetic. A
 * disclosure the model could rephrase is a disclosure that can drift.
 *
 * `{{date}}` is the episode Monday; see introTurns().
 */
const INTRO_TEMPLATE = `**Maya:** Good morning, and welcome to Chino Valley Today, the Week in Review. I'm Maya.

**Dan:** And I'm Dan. This show is produced automatically from posts published on Chino Valley Today, and we are synthetic voices. It's {{date}}.`;

/** Not generated either, and for the same reason. */
const OUTRO = `## Sign-off

**Maya:** That's the week. Every story in this episode links to its primary source at chinovalley.today.

**Dan:** This show is generated automatically and is not a substitute for official minutes or notices. Thanks for listening.`;

/** "Monday, September 7, 2026" — the episode date as the intro speaks it. */
function episodeDateLabel(monday: Date): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	}).format(monday);
}

function introTurns(monday: Date): string {
	return INTRO_TEMPLATE.replace("{{date}}", episodeDateLabel(monday));
}

/**
 * The publishable transcript: fixed intro turns, then the generated draft,
 * then the fixed sign-off.
 *
 * The intro lands INSIDE the draft's `## Cold open` rather than above it, so
 * the episode opens on one section instead of a heading-less preamble.
 */
export function composeTranscript(draftMd: string, monday: Date): string {
	const draft = draftMd.trim();
	const idx = draft.indexOf(`## ${SECTIONS[0]}`);
	if (idx === -1) throw new Error(`draft has no "## ${SECTIONS[0]}" heading`);
	const rest = draft.slice(idx + SECTIONS[0].length + 3).replace(/^\s+/, "");
	return `## ${SECTIONS[0]}\n\n${introTurns(monday)}\n\n${rest}\n\n${OUTRO}\n`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface PodcastTurn {
	section: string;
	host: Host;
	text: string;
	urls: string[];
}

/**
 * A turn's spoken words: what a listener hears, with the citation removed.
 *
 * Accepts a whole turn line or just the part after the host label, because the
 * checks below read one and the audio renderer reads the other.
 */
export function spokenText(turnRaw: string): string {
	return turnRaw
		.replace(/^\*\*(?:Maya|Dan):\*\*\s*/, "")
		.replace(MD_LINK_RE, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function parseTurns(md: string): PodcastTurn[] {
	const turns: PodcastTurn[] = [];
	let section = "";
	for (const raw of md.split("\n")) {
		const line = raw.trim();
		const heading = HEADING_RE.exec(line);
		if (heading) {
			section = heading[1].trim();
			continue;
		}
		const turn = TURN_RE.exec(line);
		if (!turn) continue;
		turns.push({
			section,
			host: turn[1] as Host,
			text: spokenText(turn[2]),
			urls: [...turn[2].matchAll(MD_LINK_RE)].map((m) => m[1]),
		});
	}
	return turns;
}

function wordCount(s: string): number {
	return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Format checks Gate 1 has no way to express, merged into its report by
 * gate-run's `extraChecks`. Every failure is `markup`: each one says the draft
 * is not shaped like a transcript, which is the gate the validators use for
 * structural defects.
 */
export function podcastChecks(draftMd: string): GateFailure[] {
	const failures: GateFailure[] = [];
	const headings: string[] = [];
	const strays: string[] = [];
	for (const raw of draftMd.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = HEADING_RE.exec(line);
		if (heading) {
			headings.push(heading[1].trim());
			continue;
		}
		if (!TURN_RE.test(line)) strays.push(line);
	}
	// Capped: a draft in the wrong format entirely produces one of these per
	// line, and the repair prompt is sent every failure verbatim.
	for (const line of strays.slice(0, 5)) {
		failures.push({
			gate: "markup",
			detail:
				"every line must be a section heading or a host turn starting **Maya:** or **Dan:**",
			excerpt: line.slice(0, 140),
		});
	}
	if (headings.join(" | ") !== SECTIONS.join(" | ")) {
		failures.push({
			gate: "markup",
			detail: `sections must be exactly "## ${SECTIONS.join('", "## ')}" in that order; found ${
				headings.length ? headings.map((h) => `"${h}"`).join(", ") : "none"
			}`,
		});
	}

	// One citation, at the end, on every turn. Gate 1 only asks for at least
	// one link somewhere; the renderer strips links, so a citation in the
	// middle of a sentence leaves a hole in the spoken line.
	for (const raw of draftMd.split("\n")) {
		const turn = TURN_RE.exec(raw.trim());
		if (!turn) continue;
		const links = [...turn[2].matchAll(MD_LINK_RE)];
		if (links.length !== 1 || !/\]\([^)\s]*\)$/.test(turn[2].trim())) {
			failures.push({
				gate: "markup",
				detail:
					"every turn must end with exactly one [source](URL) citation and carry no other links",
				excerpt: turn[2].slice(0, 140),
			});
		}
	}

	const turns = parseTurns(draftMd);
	for (const [i, t] of turns.entries()) {
		if (i > 0 && turns[i - 1].host === t.host) {
			failures.push({
				gate: "markup",
				detail: `${t.host} speaks twice in a row; the hosts must alternate`,
				excerpt: t.text.slice(0, 140),
			});
		}
		if (t.text.endsWith("?")) {
			failures.push({
				gate: "markup",
				detail:
					"no host asks the other a question; state the fact instead of asking for it",
				excerpt: t.text.slice(-140),
			});
		}
	}

	// An empty section is an empty TTS request and a zero-length chapter.
	for (const name of SECTIONS) {
		if (headings.includes(name) && !turns.some((t) => t.section === name)) {
			failures.push({
				gate: "markup",
				detail: `section "## ${name}" has no turns`,
			});
		}
	}

	const words = turns.reduce((n, t) => n + wordCount(t.text), 0);
	if (words < 600 || words > 1300) {
		failures.push({
			gate: "markup",
			detail: `spoken length is ${words} words; the episode must be between 600 and 1300 (target 900-1100)`,
		});
	}
	return failures;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** One line of fact per calendar event, and who a holiday closes. */
export function eventLine(e: BriefEventAhead): string {
	const base = `${e.date} ${e.time ?? ""} ${e.venue ?? ""}`
		.replace(/\s+/g, " ")
		.trim();
	// A folded holiday closure's whole content is who is closed, and it lives in
	// `closed` rather than in the title — without it the week-ahead section can
	// name the holiday and nothing else about it.
	const closed = e.closed?.length
		? ` Closed: ${e.closed.map((c) => c.label).join(", ")}.`
		: "";
	return `${base}${closed}`;
}

function postItem(p: PodcastPost): BundleItem {
	return {
		title: p.title,
		body: p.bodyMd,
		sourceUrl: p.url,
		meta: { publishedAt: p.publishedAt },
		occurredAt: p.publishedAt,
		contentHash: sha256(p.bodyMd),
	};
}

function eventItem(e: BriefEventAhead): BundleItem {
	const body = eventLine(e);
	return {
		title: e.title,
		body,
		sourceUrl: e.url,
		meta: {},
		occurredAt: e.date,
		contentHash: sha256(body),
	};
}

/**
 * The synthesis input, in the shape Gate 2's judge already knows how to read.
 * Its `allowedUrls` are the only URLs a turn may cite and its `inputCorpus` is
 * the only text a number or a name may come from — including the fixed intro
 * and outro, which the model has not been given but does sometimes echo.
 */
export function buildPodcastBundle(
	inputs: PodcastInputs,
	monday: Date,
): MeetingBundle {
	const mondayDate = localMeetingDate(monday.toISOString());
	if (!mondayDate) throw new Error(`unusable episode date: ${monday}`);
	// Posts ride as transcript segments, not agenda items: the judge renders an
	// agenda item's body cut to 500 characters, which would show it the opening
	// of each story and nothing the episode says about the rest. Segments are
	// rendered whole, and bundleForJudge keeps every one the draft cites.
	const postItems = inputs.posts.map(postItem);
	const eventItems = inputs.events.map(eventItem);
	const items = [...postItems, ...eventItems];
	const corpus = [
		SHOW_TITLE,
		...HOSTS,
		"Chino Valley Today",
		"Week in Review",
		introTurns(monday),
		OUTRO,
		episodeDateLabel(monday),
		...items.flatMap((i) => [i.title ?? "", i.body ?? ""]),
	];
	return {
		targetKey: `podcast:${isoWeekOf(monday)}`,
		sourceKey: "podcast",
		bodyName: "Week in Review",
		meetingDate: mondayDate,
		agendaItems: eventItems,
		votes: [],
		transcriptSegments: postItems,
		allowedUrls: [...new Set(items.map((i) => i.sourceUrl))],
		inputCorpus: corpus.join("\n"),
	};
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const PODCAST_SYSTEM = `You write the script for "Chino Valley Today, the Week in Review", a weekly two-host news podcast about Chino and Chino Hills, California. Two synthetic voices, Maya and Dan, read it aloud. Your output is the script and nothing else.

TONE
Calm public radio. Plain declarative sentences a person can follow by ear the first time. Never breathless, never promotional, never chatty. No jokes, no opinions, no editorializing, no speculation about what anything means or what happens next.

FORMAT — follow exactly; a script that breaks any of these rules is discarded.
- Exactly three sections, in this order, spelled exactly:
## Cold open
## Last week
## Week ahead
- Every other line is one turn: a blank line, then a single paragraph beginning "**Maya:** " or "**Dan:** ". Nothing else may appear — no bullet lists, no bold, no italics, no stage directions, no host names anywhere but at the start of a turn.
- Maya and Dan strictly alternate: no host speaks twice in a row.
- NO HOST EVER ASKS THE OTHER A QUESTION. No turn may end with a question mark. Two hosts alternate reading facts; they do not interview each other.
- No reactions, no agreement, no banter. Never "That's right", "Interesting", "As we reported", "More on that later", "Stay with us".
- Every turn ends with exactly one citation in the form [source](URL), using a URL copied character-for-character from the citable list. One turn, one source.
- Total spoken length across the three sections: 900 to 1,100 words.
- Cold open: two or three turns teasing the biggest items. Last week: the week's published stories. Week ahead: the coming week's scheduled events.

FACTS
- Use ONLY what the source material below states. If it is not there, it does not go in the script. Never add background, context, history, population figures, explanations of what a body does, or anything you happen to know about Chino Valley.
- Never add a descriptive or technical word the source does not use, even when it is the usual term for the thing. A source saying "DUI patrols" does not license "DUI saturation patrols"; a source saying "a meeting" does not license "a special meeting". This is the single easiest mistake to make, because the added word is almost always plausible.
- Some posts are a headline and a few fields with no body text at all, common for alerts. For those, say what the title says and stop. A short turn is correct; padding one out is how invented detail gets in.
- Name a body, an event or a place exactly as the source material names it. Do not add a city, an agency or any other qualifier in front of a name, even a correct one: "Parks and Recreation Commission" does not become "Chino Hills Parks and Recreation Commission".
- Describe two listings as one event only when the sources show they ARE one event — same title, same registration link, or one plainly a translation of the other. Matching time and place alone is not enough; two different programs can share a venue and a start time, so keep them separate when in doubt. Use the words the listing uses, and never infer an attribute the sources do not state — a listing written in Spanish does not say the word "Spanish".
- Write every number, date, time, dollar amount and vote tally EXACTLY as the source writes it: "September 8", "6:00 PM", "$1.2 million", "4-1". Do not spell numbers out, do not convert them, do not round them, do not reformat a date.
- Attribute rather than assert: "according to the agenda", "the sheriff's station said", "the city's notice says", "per the district's calendar". A recap of a meeting is a summary of the public record, never "the minutes".
- Never say a story was reported by us or anyone else, and never refer to previous episodes.

PEOPLE
- Name elected officials, senior public employees acting in their official capacity, and business principals in the context of their own license or application. Nobody else.
- Never name or identifiably describe a minor, under any circumstances, even if the source material names them. Sports items are team-level only: scores, records and schedules, never a student athlete's name.
- Never name a private individual in connection with a crime, an allegation, an arrest, or a personnel or legal matter. Describe what the agency said happened, without the person.
- On contested school-district items, report only what was decided and how members voted. No characterization of motives, tone, or sides.

Output the script only. No preamble, no title, no closing note, no explanation.`;

/** The user message: the citable URLs, then the material, and nothing else. */
export function podcastPromptBody(inputs: PodcastInputs, monday: Date): string {
	const bundle = buildPodcastBundle(inputs, monday);
	const lines = [
		`# Chino Valley Today, the Week in Review — episode of ${episodeDateLabel(monday)}`,
		"",
		"## Citable source URLs (the ONLY URLs you may cite; copy them exactly):",
		...bundle.allowedUrls.map((u) => `- ${u}`),
		"",
		"## Stories published last week",
	];
	for (const p of inputs.posts) {
		lines.push("", `### ${p.title}`, `source: ${p.url}`, p.bodyMd.trim());
	}
	lines.push("", "## Week ahead events");
	if (inputs.events.length === 0) {
		lines.push("(none scheduled)");
	} else {
		for (const e of inputs.events) {
			lines.push(`- ${e.title} — ${eventLine(e)} — source: ${e.url}`);
		}
	}
	return lines.join("\n");
}

/** Appended to gate-run's repair instructions, which know nothing of scripts. */
export const PODCAST_REPAIR_GUIDANCE =
	'If a failure says a line is not a host turn, rewrite that line as one paragraph beginning "**Maya:** " or "**Dan:** ", keeping the hosts alternating. ' +
	"If a failure says a host asked a question, restate it as a statement of the same fact. " +
	'If a failure names the sections, fix the headings to exactly "## Cold open", "## Last week", "## Week ahead" in that order. ' +
	"If a failure gives a word count, cut or expand turns to land between 900 and 1,100 spoken words without adding any fact that is not already in the draft. ";
