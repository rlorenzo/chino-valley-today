import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diffLines, formatDiff } from "./line-diff.ts";

const render = (before: string[], after: string[]) =>
	diffLines(before, after)
		.lines.map(
			({ op, text }) =>
				`${op === "add" ? "+" : op === "remove" ? "-" : " "}${text}`,
		)
		.join("\n");

describe("diffLines", () => {
	test("identical documents produce no changes", () => {
		const result = diffLines(["a", "b", "c"], ["a", "b", "c"]);
		assert.equal(result.added, 0);
		assert.equal(result.removed, 0);
		assert.ok(result.lines.every((l) => l.op === "context"));
	});

	test("a changed clause in the middle shows as one removal and one addition", () => {
		assert.equal(
			render(
				["intro", "old clause", "outro"],
				["intro", "new clause", "outro"],
			),
			[" intro", "-old clause", "+new clause", " outro"].join("\n"),
		);
	});

	test("an inserted clause is an addition, not a rewrite of everything after it", () => {
		const result = diffLines(["a", "b"], ["a", "new", "b"]);
		assert.equal(result.added, 1);
		assert.equal(result.removed, 0);
	});

	test("keeps unchanged head and tail as context", () => {
		// Trimming them is an optimisation for the table, not a decision about
		// what the reader sees: a change needs lines around it to be readable.
		const result = diffLines(["a", "b", "x", "c"], ["a", "b", "y", "c"]);
		assert.equal(result.lines.length, 5);
		assert.equal(result.lines[0].text, "a");
		assert.equal(result.lines.at(-1)?.text, "c");
	});

	test("an empty document against a full one is all additions", () => {
		const result = diffLines([], ["a", "b"]);
		assert.equal(result.added, 2);
		assert.equal(result.removed, 0);
	});
});

describe("formatDiff", () => {
	test("elides long unchanged runs around a change", () => {
		const before = Array.from({ length: 40 }, (_, i) => `line ${i}`);
		const after = [...before];
		after[20] = "line 20 CHANGED";

		const out = formatDiff(diffLines(before, after), 2);

		assert.match(out, /- line 20\n\+ line 20 CHANGED/);
		assert.match(out, /\.\.\. 18 unchanged line\(s\) \.\.\./);
		// The point of eliding: a reader sees the change, not the document.
		assert.ok(
			out.split("\n").length < 12,
			`expected a short rendering, got:\n${out}`,
		);
	});

	test("reports an unchanged text as a finding, not as an empty result", () => {
		// The likeliest answer, and the one that matters: on 2026-08-23 all three
		// held sources had changed bytes and unchanged wording. Rendering that as
		// a lone "... 132 unchanged line(s) ..." reads like nothing happened.
		const doc = Array.from({ length: 132 }, (_, i) => `clause ${i}`);
		assert.equal(
			formatDiff(diffLines(doc, doc)),
			"(the page changed, but not one word of the text did)",
		);
	});

	test("says so plainly when the region is too large to diff exactly", () => {
		const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`);
		const after = Array.from({ length: 1200 }, (_, i) => `new ${i}`);

		const result = diffLines(before, after);
		assert.equal(result.truncated, true);
		assert.match(formatDiff(result), /too large to diff exactly/);
	});
});
