import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderMarkdown } from "./admin/render.ts";
import { esc } from "./html.ts";

// esc() is the single escaping boundary for every page this project renders.
// The admin dashboard displays LLM-generated drafts built from scraped material
// (including video transcripts), so these are the tests standing between that
// text and an injection sink.

describe("esc", () => {
	test("escapes all four characters that can break out of markup", () => {
		assert.equal(
			esc('<script>alert("x")</script>'),
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
		);
	});

	test("escapes & FIRST, so nothing is double-escaped", () => {
		// If "<" were replaced before "&", the "&" it introduces would then be
		// escaped again and render as literal "&amp;lt;" instead of "<".
		assert.equal(esc("<"), "&lt;");
		assert.equal(esc("&"), "&amp;");
		assert.equal(
			esc("&lt;"),
			"&amp;lt;",
			"an already-escaped entity escapes its ampersand only",
		);
	});

	test("an attribute cannot be broken out of", () => {
		const payload = '" onerror="alert(1)';
		assert.equal(esc(payload).includes('"'), false);
	});

	test("a single-quoted attribute cannot be broken out of either", () => {
		assert.equal(esc("' onerror='alert(1)"), "&#39; onerror=&#39;alert(1)");
	});

	test("null and undefined render as empty, not as the words", () => {
		assert.equal(esc(null), "");
		assert.equal(esc(undefined), "");
	});

	test("non-strings are stringified", () => {
		assert.equal(esc(42), "42");
		assert.equal(esc(0), "0");
		assert.equal(esc(false), "false");
	});
});

describe("renderMarkdown escaping order", () => {
	// The hand-rolled renderer is safe ONLY because inline() escapes before it
	// applies link/bold/italic transforms. Swapping that order — an easy accident
	// in a refactor — turns draft text into an injection sink. Nothing pinned it
	// before this test.
	test("a script tag in draft text never becomes live markup", () => {
		const out = renderMarkdown(
			"A draft containing <script>alert(1)</script> inline.",
		);
		assert.equal(out.includes("<script>"), false);
		assert.match(out, /&lt;script&gt;/);
	});

	test("an img onerror payload is inert", () => {
		const out = renderMarkdown('Text <img src=x onerror="alert(1)"> more.');
		assert.equal(out.includes("<img"), false);
		assert.equal(out.includes('onerror="'), false);
	});

	test("a javascript: link is not turned into an anchor", () => {
		// The link pattern requires an http(s) scheme, matched against text that
		// has already been escaped.
		const out = renderMarkdown("[click me](javascript:alert(1))");
		assert.equal(out.includes('<a href="javascript:'), false);
	});

	test("legitimate markdown still renders", () => {
		const out = renderMarkdown(
			"A **bold** claim [source](https://example.gov/a).",
		);
		assert.match(out, /<strong>bold<\/strong>/);
		assert.match(out, /<a href="https:\/\/example\.gov\/a"[^>]*>source<\/a>/);
	});

	test("a link's visible text is escaped even when the URL is valid", () => {
		const out = renderMarkdown("[<b>x</b>](https://example.gov/a)");
		assert.equal(out.includes("<b>x</b>"), false);
	});
});
