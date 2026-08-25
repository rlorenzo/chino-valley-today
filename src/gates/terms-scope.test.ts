import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	classifyDrift,
	readNonVolatile,
	type TermsScope,
} from "./terms-scope.ts";

const SCOPE: TermsScope = {
	select: "article#staticpage",
	volatile: "[id^=tncms-region]",
	anchor: "These Terms of Service govern your use of",
	// Small, because these fixtures are small. The real Champion scope reads
	// 26,604 characters and floors at 20,000.
	minLength: 100,
};

// Mirrors the shape that matters on the real page: the churning widget region
// is nested INSIDE the terms article, so selecting the article is not enough.
function page(opts: {
	headlines: string[];
	terms?: string;
	href?: string;
	extra?: string;
}): string {
	const terms =
		opts.terms ??
		"These Terms of Service govern your use of ChampionNewspapers.com. You may not republish any portion of the Content.";
	return `<html><body><article id="staticpage">
		<header><h1>Terms of Service</h1></header>
		<p>${terms}</p>
		<p>See our <a href="${opts.href ?? "/site/privacy.html"}">Privacy Policy</a>.</p>
		${opts.extra ?? ""}
		<div id="tncms-region-global-side-primary">
			<h4>Articles</h4>
			<ul>${opts.headlines.map((h) => `<li>${h}</li>`).join("")}</ul>
		</div>
	</article></body></html>`;
}

describe("readNonVolatile", () => {
	test("drops the volatile region and keeps the terms", () => {
		const res = readNonVolatile(
			page({ headlines: ["Rattlers appear"] }),
			SCOPE,
		);
		assert.ok(res.ok);
		assert.match(res.text, /govern your use of/);
		assert.doesNotMatch(res.text, /Rattlers/);
	});

	test("strips script and style before reading text", () => {
		// cheerio's .text() concatenates the contents of those elements too, so
		// leaving them in would put CSS rules and JS source into the canonical
		// form and read a rebuilt asset id as a terms change.
		const withStyle = page({ headlines: [] }).replace(
			"<header>",
			"<style>.x{display:none}</style><script>var build='abc123';</script><header>",
		);
		const a = readNonVolatile(withStyle, SCOPE);
		const b = readNonVolatile(page({ headlines: [] }), SCOPE);
		assert.ok(a.ok && b.ok);
		assert.equal(a.digest, b.digest);
	});

	test("fails when the scope selector matches nothing", () => {
		const res = readNonVolatile("<html><body><p>hi</p></body></html>", SCOPE);
		assert.ok(!res.ok);
		assert.match(res.reason, /matched nothing/);
	});

	test("fails when the scope selector matches more than one element", () => {
		// Ambiguity, not abundance: a template that suddenly has two terms
		// containers is a change worth a human.
		const doubled = `<article id="staticpage"><p>${SCOPE.anchor} x</p></article><article id="staticpage"><p>y</p></article>`;
		const res = readNonVolatile(`<html><body>${doubled}</body></html>`, SCOPE);
		assert.ok(!res.ok);
		assert.match(res.reason, /matched 2 elements/);
	});

	test("a volatile selector cannot hide a second terms container", () => {
		// The ordering guard. If removal ran before the count, a volatile
		// selector that happened to match the second container would delete it,
		// drop the count to 1, and slip past the ambiguity check into a
		// volatile-only verdict that --attest can act on.
		const doubled =
			`<article id="staticpage"><p>${SCOPE.anchor} first copy.</p></article>` +
			`<article id="staticpage" class="tncms-region"><p>second copy</p></article>`;
		const res = readNonVolatile(`<html><body>${doubled}</body></html>`, {
			...SCOPE,
			volatile: ".tncms-region",
		});
		assert.ok(!res.ok);
		assert.match(res.reason, /matched 2 elements/);
	});

	test("link targets cannot pad a collapsed reading past the floor", () => {
		// The floor measures the text, not the canonical form. A nav-heavy
		// leftover carries enough hrefs to clear a length check while the terms
		// themselves have collapsed — the exact case the floor exists to catch.
		// Long targets, one-character labels: the visible text stays tiny (link
		// wording is legitimately part of the terms) while the href list alone
		// runs to hundreds of characters.
		const links = Array.from(
			{ length: 20 },
			(_, i) => `<a href="/section/${i}/a-fairly-long-path-segment-here">.</a>`,
		).join("");
		const collapsed = `<html><body><article id="staticpage"><p>${SCOPE.anchor} x.</p>${links}</article></body></html>`;
		const res = readNonVolatile(collapsed, SCOPE);
		assert.ok(!res.ok, "hrefs must not count toward the minimum");
		assert.match(res.reason, /below the 100/);
	});

	test("fails when the anchor is swallowed into the volatile region", () => {
		// The fail-open this guard exists for: an unclosed tag inside a widget
		// makes the parser nest the legal body into the subtree being removed,
		// so the whole agreement would count as churn.
		const swallowed = `<html><body><article id="staticpage">
			<div id="tncms-region-global-side-primary"><h4>Articles</h4>
			<p>${SCOPE.anchor} ChampionNewspapers.com.</p>
			</div></article></body></html>`;
		const res = readNonVolatile(swallowed, SCOPE);
		assert.ok(!res.ok);
		assert.match(res.reason, /anchor phrase is absent/);
	});
});

describe("readNonVolatile, continued", () => {
	test("returns the link targets it folded into the digest", () => {
		// They are compared but invisible in the text, so a caller showing terms
		// to an operator needs them separately.
		const res = readNonVolatile(page({ headlines: [] }), SCOPE);
		assert.ok(res.ok);
		assert.deepEqual(res.hrefs, ["/site/privacy.html"]);
	});

	test("does not claim to see through CSS cloaking", () => {
		// Honest limit: a clause hidden with display:none is still in .text(),
		// and removing the stylesheet does not change that. Only a renderer
		// could, and the raw bytes stay archived either way.
		const hidden = page({
			headlines: [],
			extra: '<p style="display:none">Automated access is prohibited.</p>',
		});
		const res = readNonVolatile(hidden, SCOPE);
		assert.ok(res.ok);
		assert.match(res.text, /Automated access is prohibited/);
	});
});

describe("classifyDrift", () => {
	const approved = page({ headlines: ["Old story one", "Old story two"] });

	test("headline churn alone is volatile-only", () => {
		const observed = page({ headlines: ["FBI raids supervisor's home"] });
		const res = classifyDrift(approved, observed, SCOPE);
		assert.equal(res.verdict, "volatile-only");
	});

	test("a changed clause is a terms change", () => {
		const observed = page({
			headlines: ["Old story one", "Old story two"],
			terms:
				"These Terms of Service govern your use of ChampionNewspapers.com. No automated access of any kind is permitted.",
		});
		const res = classifyDrift(approved, observed, SCOPE);
		assert.equal(res.verdict, "terms-changed");
	});

	test("a link retargeted under unchanged wording is a terms change", () => {
		// Text alone is blind to this: "Privacy Policy" still reads the same
		// while pointing at a different document.
		const observed = page({
			headlines: ["Old story one", "Old story two"],
			href: "/site/privacy-v2.html",
		});
		const res = classifyDrift(approved, observed, SCOPE);
		assert.equal(res.verdict, "terms-changed");
	});

	test("a clause appended outside the volatile region is a terms change", () => {
		const observed = page({
			headlines: ["Old story one", "Old story two"],
			extra: "<p>Additional terms apply to automated access.</p>",
		});
		const res = classifyDrift(approved, observed, SCOPE);
		assert.equal(res.verdict, "terms-changed");
	});

	test("a symmetric collapse to a hollow skeleton is indeterminate, not a match", () => {
		// The case a ratio cannot see. If the scope goes broad enough to strip the
		// terms, BOTH versions reduce to the same near-empty tree: identical
		// digests, a size ratio of exactly 1, and nothing of substance compared.
		// Only a floor fixed outside the documents catches it.
		const hollow = `<html><body><article id="staticpage">
			<p>${SCOPE.anchor} x.</p>
		</article></body></html>`;
		const res = classifyDrift(hollow, hollow, SCOPE);
		assert.equal(res.verdict, "indeterminate");
		assert.match((res as { reason: string }).reason, /below the 100/);
	});

	test("the floor is not a ratio: two hollow versions still do not match", () => {
		const hollow = `<html><body><article id="staticpage"><p>${SCOPE.anchor} x.</p></article></body></html>`;
		const before = readNonVolatile(hollow, SCOPE);
		assert.ok(!before.ok, "a hollow reading must not be usable at all");
	});

	test("an unreadable approved version is indeterminate, never a match", () => {
		const res = classifyDrift(
			"<html><body>gone</body></html>",
			approved,
			SCOPE,
		);
		assert.equal(res.verdict, "indeterminate");
		assert.match((res as { reason: string }).reason, /approved version/);
	});
});
