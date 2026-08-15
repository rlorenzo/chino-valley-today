import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRawCues } from "./youtube-shared.ts";

// YouTube auto-caption VTT uses a rolling two-line display and per-word timing
// tags. parseRawCues recovers an ordered, non-repeating plain-text stream from
// it; these pin the markup handling that stream depends on.

function vtt(...blocks: string[]): string {
	return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

describe("parseRawCues — markup stripping", () => {
	test("per-word timing tags and <c> spans are removed", () => {
		const cues = parseRawCues(
			vtt(
				"00:00:01.000 --> 00:00:03.000\nthe motion <00:00:01.500><c>carried</c> unanimously",
			),
		);
		assert.equal(cues.length, 1);
		assert.equal(cues[0].text, "the motion carried unanimously");
	});

	test("a tag truncated at end-of-line is removed, not left as junk", () => {
		// `<[^>]*>` alone leaves "<c.colorE5E5" in the stored transcript. In WebVTT
		// a literal angle bracket in caption text is escaped, so a bare `<` is
		// always markup and dropping the remainder is correct.
		const cues = parseRawCues(
			vtt("00:00:01.000 --> 00:00:03.000\nboard voted and <c.colorE5E5"),
		);
		assert.equal(cues[0].text, "board voted and");
		assert.ok(
			!cues[0].text.includes("<"),
			"no bare markup may survive into transcript text",
		);
	});

	test("an unterminated <script is removed rather than carried through", () => {
		const cues = parseRawCues(
			vtt("00:00:01.000 --> 00:00:03.000\nthe motion carried <script"),
		);
		assert.equal(cues[0].text, "the motion carried");
	});

	test("an escaped angle bracket survives as literal caption text", () => {
		// The counterpart to the rule above: &lt; is real content, decoded after
		// stripping, and must NOT be treated as markup.
		const cues = parseRawCues(
			vtt("00:00:01.000 --> 00:00:03.000\nfive &lt; ten &amp; six &gt; two"),
		);
		assert.equal(cues[0].text, "five < ten & six > two");
	});

	test("entities are decoded in one pass, not re-decoded", () => {
		// "&amp;#39;" is the wire form of the literal text "&#39;". A chain of
		// .replace() calls would decode its own output down to an apostrophe.
		const cues = parseRawCues(
			vtt("00:00:01.000 --> 00:00:03.000\nliteral &amp;#39; here"),
		);
		assert.equal(cues[0].text, "literal &#39; here");
	});
});

describe("parseRawCues — cue stream", () => {
	test("consecutive duplicate lines collapse to one", () => {
		// Every real line is followed by one exact duplicate from the transition
		// block, so the dedup is required on top of the blank-filter.
		const cues = parseRawCues(
			vtt(
				"00:00:01.000 --> 00:00:03.000\nfirst line",
				"00:00:03.000 --> 00:00:03.010\nfirst line\n ",
				"00:00:03.010 --> 00:00:05.000\nsecond line",
			),
		);
		assert.deepEqual(
			cues.map((c) => c.text),
			["first line", "second line"],
		);
	});

	test("timestamps are parsed to seconds", () => {
		const cues = parseRawCues(vtt("00:01:02.500 --> 00:01:04.250\nhello"));
		assert.equal(cues[0].start, 62.5);
		assert.equal(cues[0].end, 64.25);
	});

	test("blocks without a timestamp line are skipped", () => {
		const cues = parseRawCues(
			vtt(
				"NOTE this is a comment block",
				"00:00:01.000 --> 00:00:02.000\nreal cue",
			),
		);
		assert.equal(cues.length, 1);
		assert.equal(cues[0].text, "real cue");
	});
});
