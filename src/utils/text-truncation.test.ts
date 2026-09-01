import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanPlainText,
	splitSentences,
	truncateToSentenceBoundary,
} from "./text-truncation.ts";

test("text-truncation utils", async (t) => {
	await t.test("cleanPlainText decodes entities and strips HTML", () => {
		const raw =
			"<p>7-Eleven &amp; gas station &#39;proposal&#39; &mdash; new plan.</p>";
		assert.equal(
			cleanPlainText(raw),
			"7-Eleven & gas station 'proposal' — new plan.",
		);
	});

	// CivicPlus embeds <style scoped> inside a news release body. Its contents
	// are text nodes, so .text() returned the stylesheet as prose and the W36
	// digest published a CSS rule as the teaser for a municipal code change.
	await t.test("cleanPlainText drops style and script contents", () => {
		const raw =
			"<style scoped>* { --categoryColor: var(--cp-module-style-color6); }</style>" +
			"<h2>News Flash</h2> <p>Chino Municipal Code 9.90.010</p>" +
			"<script>var t = 1;</script>";
		assert.equal(
			cleanPlainText(raw),
			"News Flash Chino Municipal Code 9.90.010",
		);
	});

	await t.test("splitSentences handles abbreviations and quotes", () => {
		const text =
			'Mayor Dr. Jane Doe met with U.S. officials on St. John Ave. "We made progress," she said. The council will vote next week.';
		const sentences = splitSentences(text);
		assert.deepEqual(sentences, [
			'Mayor Dr. Jane Doe met with U.S. officials on St. John Ave. "We made progress," she said.',
			"The council will vote next week.",
		]);
	});

	await t.test("truncateToSentenceBoundary fits complete sentences", () => {
		const s1 = "First sentence is short.";
		const s2 = "Second sentence is also quite brief.";
		const s3 =
			"Third sentence goes beyond the character limit because it has many words and descriptive text that exceeds the bounds.";
		const combined = `${s1} ${s2} ${s3}`;

		const res = truncateToSentenceBoundary(combined, 70, 20);
		assert.equal(res, `${s1} ${s2}`);
	});

	await t.test(
		"truncateToSentenceBoundary returns null if first sentence exceeds limit",
		() => {
			const longFirst =
				"This is an extraordinarily long sentence that cannot fit within the tight word limit that has been configured for this specific test case.";
			const res = truncateToSentenceBoundary(longFirst, 30, 5);
			assert.equal(res, null);
		},
	);

	await t.test(
		"truncateToSentenceBoundary returns null on empty or whitespace",
		() => {
			assert.equal(truncateToSentenceBoundary(""), null);
			assert.equal(truncateToSentenceBoundary("   "), null);
			assert.equal(truncateToSentenceBoundary(null), null);
			assert.equal(truncateToSentenceBoundary(undefined), null);
		},
	);
});
