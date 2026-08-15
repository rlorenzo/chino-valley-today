import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeCitations } from "./gate-run.ts";

// The generator wobbles between citation syntaxes. normalizeCitations rewrites
// the unambiguous variants into the one form Gate 1's citation check accepts, so
// a good draft is not held over formatting. It runs on every draft from every
// Tier B generator and had no tests.

describe("normalizeCitations", () => {
	test("rewrites a bare bracketed URL into a markdown link", () => {
		assert.equal(
			normalizeCitations("The council voted [https://example.gov/a]."),
			"The council voted [source](https://example.gov/a).",
		);
	});

	test("rewrites a link whose visible text is itself the URL", () => {
		assert.equal(
			normalizeCitations("[https://example.gov/a](https://example.gov/a)"),
			"[source](https://example.gov/a)",
		);
	});

	test("uses the href, not the label, when the two URLs differ", () => {
		// The href is what Gate 1 checks against the allowlist, so it must win.
		assert.equal(
			normalizeCitations("[https://wrong.example/x](https://example.gov/a)"),
			"[source](https://example.gov/a)",
		);
	});

	test("leaves a properly formed citation untouched", () => {
		const ok = "The council voted [source](https://example.gov/a).";
		assert.equal(normalizeCitations(ok), ok);
	});

	test("leaves a descriptive label untouched", () => {
		// Only a bracketed URL is unambiguous enough to rewrite; a human-written
		// label carries meaning and must survive.
		const ok = "See the [full agenda packet](https://example.gov/a).";
		assert.equal(normalizeCitations(ok), ok);
	});

	test("normalizes several citations in one draft", () => {
		const out = normalizeCitations(
			"First [https://example.gov/a] and second [https://example.gov/b].",
		);
		assert.equal(
			out,
			"First [source](https://example.gov/a) and second [source](https://example.gov/b).",
		);
	});

	test("does not touch bracketed text that is not a URL", () => {
		const ok = "The motion [as amended] carried.";
		assert.equal(normalizeCitations(ok), ok);
	});

	test("leaves a draft with no citations unchanged", () => {
		assert.equal(normalizeCitations("No links here."), "No links here.");
	});
});
