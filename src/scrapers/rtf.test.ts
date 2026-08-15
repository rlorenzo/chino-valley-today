import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROOT } from "../store.ts";
import { rtfToText } from "./rtf.ts";

// The fixtures are real EventItemAgendaNote / EventItemMinutesNote values pulled
// from the archived Legistar API response in data/raw. They are what make this
// safe to change: the previous hand-rolled parser had three defects that only
// showed up against real input.
const FIXTURES = JSON.parse(
	readFileSync(
		join(ROOT, "src", "scrapers", "__fixtures__", "legistar-rtf.json"),
		"utf8",
	),
) as Array<{ field: string; rtf: string }>;

describe("rtfToText — real archived Legistar notes", () => {
	test("every fixture yields non-empty text", () => {
		assert.ok(FIXTURES.length >= 5, "fixtures must cover a spread of shapes");
		for (const { rtf } of FIXTURES) {
			const out = rtfToText(rtf);
			assert.ok(out && out.length > 0, "a real note must not parse to nothing");
		}
	});

	test("no control words leak into the text", () => {
		for (const { rtf } of FIXTURES) {
			const out = rtfToText(rtf) ?? "";
			assert.equal(
				/\\[a-z]+\d*/.test(out),
				false,
				`control word leaked: ${out.slice(0, 80)}`,
			);
			assert.equal(out.includes("{"), false);
			assert.equal(out.includes("}"), false);
		}
	});

	test("no font or colour table contents leak", () => {
		for (const { rtf } of FIXTURES) {
			const out = rtfToText(rtf) ?? "";
			assert.equal(out.includes("Arial"), false, "fonttbl leaked");
			assert.equal(
				out.includes("Riched20"),
				false,
				"generator destination leaked",
			);
		}
	});
});

// Each of these pins one defect in the parser this replaced. They would all have
// failed before.
describe("rtfToText — regressions from the hand-rolled parser", () => {
	test("literal CR/LF in the source never reaches the output", () => {
		// RTF source formatting, not content. The old scanner passed it through,
		// leaving stray carriage returns in 22 rows of the live items table.
		const out = rtfToText(
			"{\\rtf1\\ansi\\pard\\fs22 First line.\\par\r\nSecond.\\par\r\n}",
		);
		assert.equal(out, "First line.\nSecond.");
		assert.equal(out?.includes("\r"), false);
	});

	test("a single \\par is one line break, not a blank line", () => {
		// Consuming the source LF as content turned every paragraph break into a
		// double break, silently double-spacing every note.
		const out = rtfToText(
			"{\\rtf1\\ansi\\pard a\\par\r\nb\\par\r\nc\\par\r\n}",
		);
		assert.equal(out, "a\nb\nc");
	});

	test("two \\par in a row still produce a paragraph break", () => {
		const out = rtfToText("{\\rtf1\\ansi\\pard a\\par\r\n\\par\r\nb\\par\r\n}");
		assert.equal(out, "a\n\nb");
	});

	test("an ignorable destination marker does not leak an asterisk", () => {
		// `\*` marks an optional destination. The old parser emitted it literally,
		// which is how a stray "*" reached a stored minutes note.
		const out = rtfToText(
			"{\\rtf1\\ansi{\\*\\generator Riched20 5.40;}\\pard\\fs22 Body.\\par\r\n}",
		);
		assert.equal(out, "Body.");
	});

	test("an UNKNOWN ignorable destination is skipped whole", () => {
		// The real point of `\*`: a reader must skip destinations it does not
		// recognise. The old parser used a hardcoded name list, so anything not on
		// it leaked its contents as body text.
		const out = rtfToText(
			"{\\rtf1\\ansi{\\*\\somefuturedest secret metadata;}\\pard Body.\\par\r\n}",
		);
		assert.equal(out, "Body.");
		assert.equal(out?.includes("secret"), false);
	});
});

describe("rtfToText — input handling", () => {
	test("plain text passes through untouched", () => {
		// Legistar populates these fields with plain text as often as RTF.
		assert.equal(
			rtfToText("There were no requests to speak."),
			"There were no requests to speak.",
		);
	});

	test("null, empty, and whitespace-only all yield null", () => {
		assert.equal(rtfToText(null), null);
		assert.equal(rtfToText(""), null);
		assert.equal(rtfToText("   \n  "), null);
	});

	test("an RTF document with no body text yields null", () => {
		assert.equal(rtfToText("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}}"), null);
	});

	test("\\tab becomes a tab", () => {
		assert.equal(rtfToText("{\\rtf1\\ansi\\pard a\\tab b\\par\r\n}"), "a\tb");
	});

	test("escaped braces and backslashes survive as literal characters", () => {
		// These arrive as control SYMBOLS (a control token whose word is the
		// character itself), not as text, so they are easy to drop by accident.
		assert.equal(rtfToText("{\\rtf1\\ansi\\pard 50\\{a\\}\\par\r\n}"), "50{a}");
		assert.equal(rtfToText("{\\rtf1\\ansi\\pard a\\\\b\\par\r\n}"), "a\\b");
	});

	test("a \\u escape decodes to its codepoint", () => {
		// 舗 is a right single quote; the trailing ? is the fallback character
		// for readers without Unicode support and must not appear.
		assert.equal(
			rtfToText("{\\rtf1\\ansi\\pard Council\\u8217?s vote\\par\r\n}"),
			"Council’s vote",
		);
	});
});
