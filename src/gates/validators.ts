// Gate 1: deterministic, paranoid validators that decide whether an LLM draft
// may auto-publish (Tier B) or must be held for human review. Fail = hold.
// A false HOLD costs minutes of human time; a false PASS publishes a
// hallucination. When a rule is ambiguous, this module resolves it toward
// failing. Full rationale and calibration notes: reports/notes/phase1-validators.md
//
// This module is self-contained (no imports) so it has zero coupling to the
// rest of the pipeline and can be unit tested in isolation.

export interface GateInput {
	bodyMd: string; // the draft (markdown), NOT including YAML frontmatter
	allowedUrls: string[]; // the input items' source_urls — the ONLY citable URLs
	inputCorpus: string; // concatenated text of all input items (titles+bodies+meta values)
}

export interface GateFailure {
	gate: "citations" | "numeric" | "proper_names";
	detail: string;
	excerpt?: string;
}

export interface GateReport {
	pass: boolean;
	failures: GateFailure[];
	stats: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, n = 140): string {
	const t = s.trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Markdown link: [text](url "optional title"). Deliberately does not handle a
// literal ')' inside the URL itself (rare in practice for our sources; a link
// with such a URL would fail closed as an unterminated/garbled link).
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function findLinks(text: string): { text: string; url: string }[] {
	return [...text.matchAll(MD_LINK_RE)].map((m) => ({
		text: m[1],
		url: parseLinkUrl(m[2]),
	}));
}

function parseLinkUrl(raw: string): string {
	const trimmed = raw.trim();
	const spaceIdx = trimmed.search(/\s/); // strip a trailing "title" after the URL
	return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

function normalizeUrl(u: string): string {
	const t = u.trim();
	return t.length > 1 && t.endsWith("/") ? t.slice(0, -1) : t;
}

// Replace markdown links with just their link text, and strip bare URLs, so
// numeric/name scanning never trips on IDs or path segments inside a URL.
//
// How a label is spliced depends on the link's position, because two failure
// modes pull in opposite directions:
// - A link in CITATION position — followed by SENTENCE-ENDING punctuation
//   ([.!?]), another link, or the end of the block — is trailing citation
//   chrome ("...for six LLMDs [LLMD item](url)."). Its label is set off by newlines (a
//   sentence boundary for the name tokenizer) so it cannot fuse with
//   adjacent prose into a phantom name like "LLMDs LLMD"; splicing it
//   seamlessly would erase the bracket the whitespace-gap anti-fusion rule
//   relies on. Label text itself stays fully scanned as its own part.
// - A link MID-SENTENCE — followed by more prose — is being used as
//   content ("Maria [Lopez](url) spoke"). Its label splices seamlessly so
//   the reader-visible adjacency stays scanned strictly: a hallucinated
//   composite name split across a link boundary must still fail as a
//   whole sequence, not pass on separately-grounded halves. This includes
//   a link followed by a comma/semicolon/colon continuation ("[Lopez](url),
//   spoke") — non-sentence-ending punctuation means the link is embedded in
//   the clause, not trailing it (Codex follow-up finding: treating ANY
//   punctuation as citation position reopened the composite-name bypass).
//   Nothing is lost by splicing here: post-splice, the surviving punctuation
//   itself blocks fusion with what FOLLOWS via the whitespace-gap rule.
//   A chain of links counts as citation position only if the CHAIN
//   terminates like one — "[A](u) [B](u)." is chrome, but "[A](u) [B](u),
//   spoke" is not (Codex finding: accepting 'another link' unconditionally
//   reopened the bypass with a decoy second link).
// Residual (documented, accepted): a composite name whose final token(s)
// are sentence-final citation-position labels scans as separate parts —
// "said Maria [Lopez](url)." and its chain variant "said Maria
// [Lopez](url) [source](url)." are indistinguishable, without semantics,
// from the LLMDs false positive; closing this would mean fusing every
// trailing label and re-holding good drafts. Gate 2's judge still reviews
// names in the rendered draft, and Tier B failures fail closed to held/.
const MD_LINK_HEAD_RE = /^\[[^\]]*\]\([^)]+\)/;
function isCitationTail(text: string, from: number): boolean {
	let i = from;
	for (;;) {
		while (i < text.length && /\s/.test(text[i])) i++;
		if (i >= text.length) return true;
		const ch = text[i];
		if (ch === "." || ch === "!" || ch === "?") return true;
		const link = text.slice(i).match(MD_LINK_HEAD_RE);
		if (link) {
			i += link[0].length;
			continue;
		}
		return false;
	}
}
function stripLinksToText(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]+\)/g, (m, label: string, offset: number) =>
			isCitationTail(text, offset + m.length) ? `\n${label}\n` : label,
		)
		.replace(/https?:\/\/\S+/g, "\n");
}

// ---------------------------------------------------------------------------
// Block parsing (shared structure for all three gates)
// ---------------------------------------------------------------------------

type BlockKind =
	| "heading"
	| "hr"
	| "footer"
	| "list-fact"
	| "list-pure-link"
	| "paragraph";

interface Block {
	kind: BlockKind;
	raw: string; // original text of the block (or list item), links intact
}

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING_RE = /^#{1,6}\s+/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const PURE_LINK_ITEM_RE = /^\[[^\]]*\]\([^)]+\)[.,;:]?$/;
// Hallmarks of DISCLOSURE_FOOTER (src/pipeline/posts.ts). Matching on these
// phrases — rather than "content after the last hr" alone — means a stray
// `---` divider inside genuine draft prose does not silently exempt
// everything after it from every gate. See "Footer detection" in the report.
const FOOTER_MARKER_RE = /generated from public records|corrections:/i;

function parseBlocks(bodyMd: string): Block[] {
	const normalized = bodyMd.replace(/\r\n/g, "\n");
	const chunks = normalized.split(/\n[ \t]*\n+/);
	const blocks: Block[] = [];

	for (const chunk of chunks) {
		const trimmed = chunk.trim();
		if (trimmed === "") continue;

		if (HR_RE.test(trimmed)) {
			blocks.push({ kind: "hr", raw: trimmed });
			continue;
		}

		const lines = trimmed.split("\n");
		if (lines.length === 1 && HEADING_RE.test(lines[0])) {
			blocks.push({ kind: "heading", raw: trimmed });
			continue;
		}

		if (LIST_ITEM_RE.test(lines[0])) {
			const items: string[] = [];
			let current: string[] | null = null;
			for (const line of lines) {
				if (LIST_ITEM_RE.test(line)) {
					if (current) items.push(current.join(" "));
					current = [line.replace(LIST_ITEM_RE, "")];
				} else if (current) {
					current.push(line.trim());
				}
			}
			if (current) items.push(current.join(" "));
			for (const item of items) {
				const t = item.trim();
				if (t === "") continue;
				blocks.push({
					kind: PURE_LINK_ITEM_RE.test(t) ? "list-pure-link" : "list-fact",
					raw: t,
				});
			}
			continue;
		}

		blocks.push({ kind: "paragraph", raw: trimmed });
	}

	// Footer detection: the LAST horizontal-rule block, if everything after it
	// carries the disclosure footer's hallmark phrases, is reclassified (along
	// with that hr block) as 'footer' and excluded from every gate below. If
	// the trailing text does NOT look like the known footer, the hr block
	// stays a plain (exempt) hr and whatever follows is gated normally — a
	// deliberate fail-closed choice over "trust every trailing ---".
	let lastHr = -1;
	for (let i = 0; i < blocks.length; i++)
		if (blocks[i].kind === "hr") lastHr = i;
	if (lastHr !== -1) {
		const trailing = blocks
			.slice(lastHr + 1)
			.map((b) => b.raw)
			.join("\n");
		if (FOOTER_MARKER_RE.test(trailing)) {
			for (let i = lastHr; i < blocks.length; i++)
				blocks[i] = { ...blocks[i], kind: "footer" };
		}
	}

	return blocks;
}

// ---------------------------------------------------------------------------
// Gate 1a — citations
// ---------------------------------------------------------------------------
//
// Rules (exact):
// 1. The draft is split into blank-line-delimited blocks. List blocks are
//    further split so each list item is evaluated on its own.
// 2. EXEMPT from the "must contain a link" requirement (not substantive):
//    - headings (`#`..`######` lines)
//    - horizontal rules (`---`, `***`, `___` alone on a line)
//    - the disclosure footer: the trailing region starting at the LAST hr
//      block, when what follows that hr matches the known footer phrasing
//      (see FOOTER_MARKER_RE above)
//    - "pure link" list items: a list item whose entire content (after the
//      marker) is nothing but a single markdown link, e.g. "- [Agenda](url)".
//      These trivially contain a link already; the exemption matters because
//      they are reference/source-list entries, not fact claims, so they are
//      not counted toward "the draft has substantive content" below.
// 3. Every remaining block (prose paragraphs, and list items that state a
//    fact) — "substantive" blocks — MUST contain at least one markdown link.
// 4. A draft with ZERO substantive blocks (empty draft, or headings-only
//    draft) fails outright — a paranoid draft is not "vacuously cited".
// 5. Every markdown link URL found anywhere in the non-footer draft (including
//    headings and pure-link list items) must be an EXACT member of
//    allowedUrls after normalizing a single trailing slash on both sides.
//    No prefix/partial matches.
function runCitationsGate(
	blocks: Block[],
	allowedUrls: string[],
): { failures: GateFailure[]; stats: Record<string, number> } {
	const failures: GateFailure[] = [];
	const allowed = new Set(allowedUrls.map(normalizeUrl));

	const substantive = blocks.filter(
		(b) => b.kind === "paragraph" || b.kind === "list-fact",
	);
	const scannable = blocks.filter((b) => b.kind !== "footer");

	if (substantive.length === 0) {
		failures.push({
			gate: "citations",
			detail:
				"draft has no substantive content (no paragraphs or fact-bearing list items found)",
		});
	}

	let uncited = 0;
	for (const b of substantive) {
		if (findLinks(b.raw).length === 0) {
			uncited++;
			failures.push({
				gate: "citations",
				detail: "substantive block has no citation link",
				excerpt: truncate(b.raw),
			});
		}
	}

	let linksTotal = 0;
	let disallowed = 0;
	for (const b of scannable) {
		for (const link of findLinks(b.raw)) {
			linksTotal++;
			if (!allowed.has(normalizeUrl(link.url))) {
				disallowed++;
				failures.push({
					gate: "citations",
					detail: `link URL is not in the allowed source list: ${link.url}`,
					excerpt: truncate(b.raw),
				});
			}
		}
	}

	return {
		failures,
		stats: {
			blocksTotal: blocks.length,
			substantiveBlocks: substantive.length,
			uncitedBlocks: uncited,
			linksTotal,
			linksDisallowed: disallowed,
		},
	};
}

// ---------------------------------------------------------------------------
// Gate 1b — numeric consistency
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];
const MONTH_INDEX: Record<string, number> = {};
for (let i = 0; i < MONTH_NAMES.length; i++) MONTH_INDEX[MONTH_NAMES[i]] = i;
const MONTH_ABBR: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	sept: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};
const MONTH_ALT = Object.keys(MONTH_INDEX)
	.concat(Object.keys(MONTH_ABBR))
	.join("|");
function monthLookup(word: string): number | undefined {
	const w = word.toLowerCase();
	return w in MONTH_INDEX ? MONTH_INDEX[w] : MONTH_ABBR[w];
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

interface Span {
	start: number;
	end: number;
}
function overlaps(span: Span, consumed: Span[]): boolean {
	return consumed.some((c) => span.start < c.end && span.end > c.start);
}

interface DateMatch extends Span {
	key: string; // canonical YYYY-MM-DD
	raw: string;
}

function extractDates(text: string): DateMatch[] {
	const out: DateMatch[] = [];

	// Digit-group boundaries use (?<!\d)/(?!\d) rather than \b: \b does not
	// fire between a digit and a following LETTER (both are \w), so a plain
	// \b-anchored regex misses "2026-08-11" when it is immediately followed by
	// "T" in a full ISO-8601 timestamp ("2026-08-11T00:25:00.000Z") — exactly
	// the format occurred_at is stored in throughout the DB. Confirmed via
	// calibration against real corpus text (reports/notes/phase1-validators.md).
	for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g)) {
		const y = Number(m[1]);
		const mo = Number(m[2]);
		const d = Number(m[3]);
		if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				key: `${y}-${pad2(mo)}-${pad2(d)}`,
				raw: m[0],
			});
		}
	}

	for (const m of text.matchAll(
		/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?!\d)/g,
	)) {
		const mo = Number(m[1]);
		const d = Number(m[2]);
		const yRaw = Number(m[3]);
		const y = yRaw < 100 ? 2000 + yRaw : yRaw;
		if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				key: `${y}-${pad2(mo)}-${pad2(d)}`,
				raw: m[0],
			});
		}
	}

	const monthDayYearRe = new RegExp(
		`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`,
		"gi",
	);
	for (const m of text.matchAll(monthDayYearRe)) {
		const mo = monthLookup(m[1]);
		const d = Number(m[2]);
		const y = Number(m[3]);
		if (mo !== undefined && d >= 1 && d <= 31) {
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				key: `${y}-${pad2(mo + 1)}-${pad2(d)}`,
				raw: m[0],
			});
		}
	}

	const dayMonthYearRe = new RegExp(
		`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?,?\\s+(\\d{4})(?!\\d)`,
		"gi",
	);
	for (const m of text.matchAll(dayMonthYearRe)) {
		const d = Number(m[1]);
		const mo = monthLookup(m[2]);
		const y = Number(m[3]);
		if (mo !== undefined && d >= 1 && d <= 31) {
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				key: `${y}-${pad2(mo + 1)}-${pad2(d)}`,
				raw: m[0],
			});
		}
	}

	return out;
}

interface TimeMatch extends Span {
	key: string; // loose "H:MM", meridiem-independent
	raw: string;
}

// Compares clock-face digits only; a bare "6:00" in the corpus grounds a
// draft's "6:00 p.m." even without a repeated meridiem marker. See report's
// "known blind spots" for the AM/PM disambiguation tradeoff this implies.
function extractTimes(text: string): TimeMatch[] {
	const out: TimeMatch[] = [];
	const re = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
	for (const m of text.matchAll(re)) {
		const h = Number(m[1]);
		const mm = m[2];
		if (h >= 0 && h <= 23) {
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				key: `${h}:${mm}`,
				raw: m[0],
			});
		}
	}
	return out;
}

interface TallyMatch extends Span {
	a: number;
	b: number;
	raw: string;
}

// Vote tallies like "5-0", "4-1". Guards: both halves <= 15 (generous upper
// bound for a local governing body's membership — tune here if a covered
// body is larger), and not part of a longer hyphen chain (excludes
// hyphenated dates like "8-12-2026", which this gate does not otherwise
// parse as a date — see report).
function extractTallies(text: string): TallyMatch[] {
	const out: TallyMatch[] = [];
	const re = /(?<!\d-)\b(\d{1,2})-(\d{1,2})\b(?!-\d)/g;
	for (const m of text.matchAll(re)) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a <= 15 && b <= 15) {
			out.push({ start: m.index, end: m.index + m[0].length, a, b, raw: m[0] });
		}
	}
	return out;
}

const NUM_RE =
	/\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*(?:%|percent|per\s?cent))?|\$?\d+(?:\.\d+)?(?:\s*(?:%|percent|per\s?cent))?/gi;

interface NumMatch extends Span {
	value: number;
	raw: string;
}

function extractGenericNumbers(text: string): NumMatch[] {
	const out: NumMatch[] = [];
	for (const m of text.matchAll(NUM_RE)) {
		const value = normalizeNumberForCompare(m[0]);
		if (value !== null)
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				value,
				raw: m[0],
			});
	}
	return out;
}

function normalizeNumberForCompare(raw: string): number | null {
	const cleaned = raw
		.replace(/percent|per\s?cent/gi, "")
		.replace(/[$,%]/g, "")
		.trim();
	if (cleaned === "" || cleaned === ".") return null;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

function runNumericGate(
	scanText: string,
	inputCorpus: string,
): { failures: GateFailure[]; stats: Record<string, number> } {
	const failures: GateFailure[] = [];

	const draftDates = extractDates(scanText);
	const corpusDateKeys = new Set(extractDates(inputCorpus).map((d) => d.key));
	const consumed: Span[] = [];
	let datesFailed = 0;
	for (const d of draftDates) {
		consumed.push(d);
		if (!corpusDateKeys.has(d.key)) {
			datesFailed++;
			failures.push({
				gate: "numeric",
				detail: `date "${d.raw}" (${d.key}) does not appear in the input corpus in any recognized form`,
				excerpt: truncate(
					scanText.slice(Math.max(0, d.start - 40), d.end + 40),
				),
			});
		}
	}

	const draftTimes = extractTimes(scanText).filter(
		(t) => !overlaps(t, consumed),
	);
	const corpusTimeKeys = new Set(extractTimes(inputCorpus).map((t) => t.key));
	let timesFailed = 0;
	for (const t of draftTimes) {
		consumed.push(t);
		if (!corpusTimeKeys.has(t.key)) {
			timesFailed++;
			failures.push({
				gate: "numeric",
				detail: `time "${t.raw}" does not appear in the input corpus`,
				excerpt: truncate(
					scanText.slice(Math.max(0, t.start - 40), t.end + 40),
				),
			});
		}
	}

	const draftTallies = extractTallies(scanText).filter(
		(t) => !overlaps(t, consumed),
	);
	const corpusNumberSet = new Set(
		extractGenericNumbers(inputCorpus).map((n) => n.value),
	);
	let talliesFailed = 0;
	for (const t of draftTallies) {
		consumed.push(t);
		const literalPresent = inputCorpus.includes(`${t.a}-${t.b}`);
		const partsPresent = corpusNumberSet.has(t.a) && corpusNumberSet.has(t.b);
		if (!literalPresent && !partsPresent) {
			talliesFailed++;
			failures.push({
				gate: "numeric",
				detail: `vote tally "${t.raw}" not corroborated by the input corpus (neither the literal tally nor both counts independently found)`,
				excerpt: truncate(
					scanText.slice(Math.max(0, t.start - 40), t.end + 40),
				),
			});
		}
	}

	const draftNumbers = extractGenericNumbers(scanText).filter(
		(n) => !overlaps(n, consumed),
	);
	let numbersFailed = 0;
	for (const n of draftNumbers) {
		if (!corpusNumberSet.has(n.value)) {
			numbersFailed++;
			failures.push({
				gate: "numeric",
				detail: `number "${n.raw.trim()}" does not appear in the input corpus`,
				excerpt: truncate(
					scanText.slice(Math.max(0, n.start - 40), n.end + 40),
				),
			});
		}
	}

	return {
		failures,
		stats: {
			datesChecked: draftDates.length,
			datesFailed,
			timesChecked: draftTimes.length,
			timesFailed,
			talliesChecked: draftTallies.length,
			talliesFailed,
			numbersChecked: draftNumbers.length,
			numbersFailed,
		},
	};
}

// ---------------------------------------------------------------------------
// Gate 1c — proper-name whitelist
// ---------------------------------------------------------------------------

const WEEKDAYS = [
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
];
const MONTH_ABBR_DISPLAY = [
	"jan",
	"feb",
	"mar",
	"apr",
	"jun",
	"jul",
	"aug",
	"sep",
	"sept",
	"oct",
	"nov",
	"dec",
];
const US_STATES = [
	"alabama",
	"alaska",
	"arizona",
	"arkansas",
	"california",
	"colorado",
	"connecticut",
	"delaware",
	"florida",
	"georgia",
	"hawaii",
	"idaho",
	"illinois",
	"indiana",
	"iowa",
	"kansas",
	"kentucky",
	"louisiana",
	"maine",
	"maryland",
	"massachusetts",
	"michigan",
	"minnesota",
	"mississippi",
	"missouri",
	"montana",
	"nebraska",
	"nevada",
	"new hampshire",
	"new jersey",
	"new mexico",
	"new york",
	"north carolina",
	"north dakota",
	"ohio",
	"oklahoma",
	"oregon",
	"pennsylvania",
	"rhode island",
	"south carolina",
	"south dakota",
	"tennessee",
	"texas",
	"utah",
	"vermont",
	"virginia",
	"washington",
	"west virginia",
	"wisconsin",
	"wyoming",
	"district of columbia",
];

// Whole-phrase, case-insensitive exemptions. Checked against the fully
// stripped (title- and sentence-initial-word-stripped) candidate phrase —
// see stripTitleAndLead() below. Keep this list small and specific; it is a
// documented, auditable tuning knob (reports/notes/phase1-validators.md).
export const BUILTIN_ALLOWLIST: readonly string[] = [
	...WEEKDAYS,
	...MONTH_NAMES,
	...MONTH_ABBR_DISPLAY,
	...US_STATES,
	"ca",
	"us",
	"usa",
	"united states",
	"chino",
	"chino hills",
	"chino valley",
	"city of chino",
	"city of chino hills",
	"san bernardino",
	"san bernardino county",
	"city council",
	"chino city council",
	"chino hills city council",
	"planning commission",
	"chino planning commission",
	"chino hills planning commission",
	"cvusd",
	"chino valley unified school district",
	"board of education",
	"chino valley today",
	"alcoholic beverage control",
	"department of alcoholic beverage control",
	"abc",
	"national weather service",
	"nws",
];
const BUILTIN_ALLOWLIST_SET = new Set(
	BUILTIN_ALLOWLIST.map((s) => s.toLowerCase()),
);

// Single-token exemption, ONLY when the token is the first word of a
// sentence (capitalized purely by sentence-initial position, not because it
// is a name). Generic English function words plus a handful of
// meeting-recap-genre institutional nouns that otherwise start sentences
// constantly in this domain ("Council approved...", "Staff recommended...").
const SENTENCE_INITIAL_COMMON_WORDS: readonly string[] = [
	"the",
	"a",
	"an",
	"this",
	"that",
	"these",
	"those",
	"it",
	"he",
	"she",
	"they",
	"we",
	"i",
	"if",
	"when",
	"while",
	"after",
	"before",
	"during",
	"on",
	"in",
	"at",
	"according",
	"under",
	"following",
	"because",
	"although",
	"though",
	"but",
	"and",
	"or",
	"so",
	"yet",
	"for",
	"with",
	"without",
	"within",
	"once",
	"as",
	"since",
	"until",
	"unless",
	"meanwhile",
	"however",
	"therefore",
	"additionally",
	"also",
	"council",
	"commission",
	"board",
	"committee",
	"members",
	"member",
	"councilmembers",
	"trustees",
	"staff",
	"residents",
	"officials",
	"voters",
	"attendees",
	"meeting",
	"item",
	"agenda",
	"motion",
	"vote",
	"public",
	"city",
	"district",
	"department",
	"police",
	"fire",
	"date",
	"time",
	"location",
	"status",
	"type",
	"source",
];
const SENTENCE_INITIAL_SET = new Set(
	SENTENCE_INITIAL_COMMON_WORDS.map((s) => s.toLowerCase()),
);

// Role/title words stripped from the LEADING position of a candidate
// sequence regardless of sentence position (titles occur mid-sentence too:
// "said Councilmember Maria Lopez"). This lets a titled reference pass on
// the strength of the bare name being grounded in the corpus, even if the
// corpus never repeats the title — while a garbled name underneath a valid
// title still fails, because the check runs on the name that remains.
const TITLE_WORDS: readonly string[] = [
	"mayor",
	"councilmember",
	"councilman",
	"councilwoman",
	"superintendent",
	"officer",
	"detective",
	"deputy",
	"sergeant",
	"captain",
	"chief",
	"commissioner",
	"trustee",
	"president",
	"chair",
	"vicechair",
	"judge",
	"sheriff",
	"dr",
	"mr",
	"mrs",
	"ms",
	"principal",
	"director",
	"administrator",
	"lieutenant",
	"governor",
	"senator",
	"assemblymember",
	"supervisor",
];
const TITLE_WORDS_SET = new Set(TITLE_WORDS.map((s) => s.toLowerCase()));

// Lowercase particles allowed WITHIN a name/entity sequence without breaking
// it (only when they sit between two capitalized tokens): "City of Chino",
// "Maria de la Cruz". Deliberately small — "and"/"the" are excluded so e.g.
// "Maria Lopez and Curtis Burton" is NOT joined into one unmatchable phrase.
const CONNECTORS = new Set([
	"of",
	"de",
	"la",
	"del",
	"da",
	"van",
	"von",
	"der",
]);

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+|\n+/g;

interface Token {
	text: string;
	start: number;
	end: number;
	sentenceInitial: boolean;
}

// Splits into sentence-like parts with their offset into the ORIGINAL text
// preserved, so downstream excerpts stay accurate. Treats markdown block/line
// breaks as boundaries too, in addition to terminal punctuation.
function splitSentences(text: string): { text: string; start: number }[] {
	const parts: { text: string; start: number }[] = [];
	let lastIndex = 0;
	for (const m of text.matchAll(SENTENCE_BOUNDARY_RE)) {
		parts.push({ text: text.slice(lastIndex, m.index), start: lastIndex });
		lastIndex = m.index + m[0].length;
	}
	parts.push({ text: text.slice(lastIndex), start: lastIndex });
	return parts;
}

// Tokens grouped by sentence part — a name-like sequence must never be
// allowed to span a sentence boundary (e.g. "...Ayala Park. Item detail"
// must NOT read as one sequence "Ayala Park Item").
function tokenizeBySentence(text: string): Token[][] {
	return splitSentences(text).map(({ text: part, start }) => {
		const tokens: Token[] = [];
		let first = true;
		for (const m of part.matchAll(WORD_RE)) {
			tokens.push({
				text: m[0],
				start: start + m.index,
				end: start + m.index + m[0].length,
				sentenceInitial: first,
			});
			first = false;
		}
		return tokens;
	});
}

// Strips a leading sentence-initial common word, then a leading title word,
// from a candidate name-like sequence. Returns null if nothing is left
// (fully exempt — e.g. "The" alone, or a bare title with no name attached).
function stripTitleAndLead(
	tokens: string[],
	sentenceInitial: boolean,
): string[] | null {
	let t = tokens;
	let leadIsSentenceInitial = sentenceInitial;
	if (
		leadIsSentenceInitial &&
		t.length > 0 &&
		SENTENCE_INITIAL_SET.has(t[0].toLowerCase())
	) {
		t = t.slice(1);
		leadIsSentenceInitial = false; // only the true first word gets this exemption
	}
	if (t.length > 0 && TITLE_WORDS_SET.has(t[0].toLowerCase())) {
		t = t.slice(1);
	} else if (
		t.length > 1 &&
		t[0].toLowerCase() === "council" &&
		t[1].toLowerCase() === "member"
	) {
		t = t.slice(2);
	}
	return t.length === 0 ? null : t;
}

// Two tokens only join into one sequence if the ORIGINAL text between them is
// pure whitespace. Without this, punctuation-separated capitalized words that
// have nothing to do with each other get fused into one bogus multi-word
// "name" that can never be grounded — e.g. a markdown bold label followed by
// its value ("**Date:** August") or a comma-separated list ("Smith, Jones").
// Confirmed as a real false-positive source via calibration against real
// Tier A posts (reports/notes/phase1-validators.md).
function isWhitespaceGap(text: string, start: number, end: number): boolean {
	return /^\s*$/.test(text.slice(start, end));
}

function findNameSequences(
	text: string,
): { phrase: string; sentenceInitial: boolean; start: number; end: number }[] {
	const out: {
		phrase: string;
		sentenceInitial: boolean;
		start: number;
		end: number;
	}[] = [];
	for (const tokens of tokenizeBySentence(text)) {
		let i = 0;
		while (i < tokens.length) {
			if (!/^[A-Z]/.test(tokens[i].text)) {
				i++;
				continue;
			}
			const seq: Token[] = [tokens[i]];
			let j = i + 1;
			while (j < tokens.length) {
				const prevEnd = tokens[j - 1].end;
				if (
					/^[A-Z]/.test(tokens[j].text) &&
					isWhitespaceGap(text, prevEnd, tokens[j].start)
				) {
					seq.push(tokens[j]);
					j++;
				} else if (
					CONNECTORS.has(tokens[j].text.toLowerCase()) &&
					isWhitespaceGap(text, prevEnd, tokens[j].start) &&
					j + 1 < tokens.length &&
					/^[A-Z]/.test(tokens[j + 1].text) &&
					isWhitespaceGap(text, tokens[j].end, tokens[j + 1].start)
				) {
					seq.push(tokens[j], tokens[j + 1]);
					j += 2;
				} else {
					break;
				}
			}
			out.push({
				phrase: seq.map((t) => t.text).join(" "),
				sentenceInitial: seq[0].sentenceInitial,
				start: seq[0].start,
				end: seq[seq.length - 1].end,
			});
			i = j;
		}
	}
	return out;
}

function runProperNamesGate(
	scanText: string,
	inputCorpus: string,
): { failures: GateFailure[]; stats: Record<string, number> } {
	const failures: GateFailure[] = [];
	// Periods become spaces (not dropped) before matching: WORD_RE never
	// captures a period, so a candidate like "Eunice M Ulloa" must still find
	// "Eunice M. Ulloa" in the corpus — collapsing "M." to "M " keeps the
	// token boundary intact instead of fusing "M" into "MUlloa".
	const corpusNorm = collapseWhitespace(
		inputCorpus.replace(/\./g, " "),
	).toLowerCase();

	const sequences = findNameSequences(scanText);
	let checked = 0;
	let failed = 0;
	for (const seq of sequences) {
		const rawTokens = seq.phrase.split(" ");
		const stripped = stripTitleAndLead(rawTokens, seq.sentenceInitial);
		if (stripped === null) continue; // fully exempt (sentence-initial common word, or bare title)

		const candidate = collapseWhitespace(stripped.join(" "));
		const candidateLower = candidate.toLowerCase();
		checked++;
		if (BUILTIN_ALLOWLIST_SET.has(candidateLower)) continue;
		if (corpusNorm.includes(candidateLower)) continue;

		failed++;
		failures.push({
			gate: "proper_names",
			detail: `name "${candidate}" does not appear in the input corpus`,
			excerpt: truncate(
				scanText.slice(Math.max(0, seq.start - 40), seq.end + 40),
			),
		});
	}

	return { failures, stats: { namesChecked: checked, namesFailed: failed } };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function validateDraft(input: GateInput): GateReport {
	const blocks = parseBlocks(input.bodyMd);

	const citations = runCitationsGate(blocks, input.allowedUrls);

	// Numeric and name gates deliberately EXCLUDE headings (template/title-case
	// text, often programmatically constructed rather than free LLM prose —
	// see report) and 'list-pure-link' items (by construction, per
	// PURE_LINK_ITEM_RE, these contain nothing but a citation link — a UI
	// label like "Full agenda packet", not a claim), as well as hr/footer
	// blocks. They run on paragraph and fact-bearing list content, with links
	// reduced to their visible text so URL path segments never masquerade as
	// facts, but link TEXT in that prose stays scanned — a claim cannot dodge
	// the gates just by living inside `[...]`.
	const scanBlocks = blocks.filter(
		(b) => b.kind === "paragraph" || b.kind === "list-fact",
	);
	const scanText = scanBlocks.map((b) => stripLinksToText(b.raw)).join("\n");

	const numeric = runNumericGate(scanText, input.inputCorpus);
	const names = runProperNamesGate(scanText, input.inputCorpus);

	const failures = [
		...citations.failures,
		...numeric.failures,
		...names.failures,
	];
	const stats: Record<string, number> = {
		...citations.stats,
		...numeric.stats,
		...names.stats,
	};

	return { pass: failures.length === 0, failures, stats };
}
