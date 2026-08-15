// RTF -> plain text for the Legistar Web API's EventItemAgendaNote and
// EventItemMinutesNote fields.
//
// Tokenizing is delegated to rtf-stream-parser (MIT, zero dependencies). The
// hand-rolled scanner this replaces was the highest-complexity function in the
// codebase and got three things wrong, all confirmed against 27 real archived
// Legistar notes:
//
//   1. Literal CR/LF in the RTF source is ignorable formatting, not content. It
//      leaked through, so "\par\r\n" produced "\n\r\n" — stray carriage returns
//      in 12 of 27 samples (22 rows in the live items table), plus a spurious
//      blank line after every paragraph.
//   2. `\*` is RTF's ignorable-destination marker. It was emitted as a literal
//      "*", which is how a stray asterisk reached a stored minutes note.
//   3. Because of (2), destination skipping relied on a hardcoded name list. The
//      whole point of `\*` is that a parser can skip destinations it does NOT
//      recognise; any unlisted `{\*\somedest ...}` leaked its contents as text.
//
// The tokenizer handles all three. What remains here is only the semantic layer:
// which destinations to drop, and how control words become whitespace.
import { Tokenize } from "rtf-stream-parser";

// Destinations whose contents are never body text. `\*`-marked destinations are
// dropped generically by the tokenizer-driven logic below, so this list only
// needs the non-optional ones RTF requires a reader to understand.
const IGNORED_DESTINATIONS = new Set([
	"fonttbl",
	"colortbl",
	"stylesheet",
	"info",
	"pict",
	"object",
	"header",
	"footer",
	"footnote",
	"listtable",
	"listoverridetable",
	"filetbl",
	"revtbl",
]);

// Token type constants from rtf-stream-parser's Tokenize stream.
const GROUP_START = 0;
const GROUP_END = 1;
const CONTROL = 2;
const TEXT = 3;

interface RtfToken {
	type: number;
	word?: string;
	param?: number;
	data?: Buffer;
}

// The stream is driven synchronously: Tokenize's transform is synchronous, so
// write()+end() emits every token before returning. That keeps this function
// sync, which matters because itemBody() and its callers are sync.
function tokenize(rtf: string): RtfToken[] {
	const tokens: RtfToken[] = [];
	const stream = new Tokenize();
	stream.on("data", (t: RtfToken) => tokens.push(t));
	// latin1 preserves each byte 1:1; \'XX escapes are resolved by the tokenizer
	// and codepage-decoded below.
	stream.write(Buffer.from(rtf, "latin1"));
	stream.end();
	return tokens;
}

export function rtfToText(rtf: string | null): string | null {
	if (!rtf) return null;
	// Legistar populates these fields with plain text as often as RTF.
	if (!rtf.startsWith("{\\rtf")) return rtf.trim() || null;

	let out = "";
	let depth = 0;
	// Depth of the group currently being skipped, or -1 when not skipping.
	let skipDepth = -1;
	// \uN is followed by `uc` fallback characters for readers that cannot handle
	// Unicode; having consumed the real codepoint, those must be dropped.
	let pendingFallback = 0;

	for (const t of tokenize(rtf)) {
		if (t.type === GROUP_START) {
			depth++;
			continue;
		}
		if (t.type === GROUP_END) {
			if (skipDepth === depth) skipDepth = -1;
			depth--;
			continue;
		}

		const skipping = skipDepth !== -1;

		if (t.type === CONTROL) {
			// `*` marks an optional destination: skip the whole group, whatever it
			// is. This is what makes unknown destinations safe.
			if (
				!skipping &&
				(t.word === "*" || IGNORED_DESTINATIONS.has(t.word ?? ""))
			) {
				skipDepth = depth;
				continue;
			}
			if (skipping) continue;

			if (t.word === "par" || t.word === "line") out += "\n";
			else if (t.word === "tab") out += "\t";
			// Control SYMBOLS, not words: `\{`, `\}` and `\\` are escaped literals,
			// and arrive here as a control token whose word is the character itself.
			// Dropping them would silently delete braces and backslashes from
			// minutes text.
			else if (t.word === "{" || t.word === "}" || t.word === "\\") {
				out += t.word;
			}
			// Non-breaking space, and the two hyphen forms.
			else if (t.word === "~") out += " ";
			else if (t.word === "_") out += "-";
			else if (t.word === "u") {
				const code = t.param ?? 0;
				// Negative params are 16-bit signed overflow for codepoints > 32767.
				out += String.fromCodePoint(code < 0 ? code + 65536 : code);
				pendingFallback = 1;
			}
			continue;
		}

		if (t.type === TEXT) {
			if (skipping) continue;
			let text = t.data?.toString("latin1") ?? "";
			if (pendingFallback) {
				text = text.slice(pendingFallback);
				pendingFallback = 0;
			}
			out += text;
		}
	}

	return (
		out
			// Trailing spaces before a break are layout, not content.
			.replace(/[ \t]+\n/g, "\n")
			// Collapse runs of blank lines, but keep a single blank line as a
			// paragraph separator.
			.replace(/\n{3,}/g, "\n\n")
			.trim() || null
	);
}
