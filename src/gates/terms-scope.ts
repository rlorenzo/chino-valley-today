// Deciding whether a changed terms page actually changed its terms.
//
// The weekly gate hashes the RAW BYTES of a publisher's terms document, and
// that stays the contract: `reviewed_hash` means "the exact document a human
// approved", with no HTML parser anywhere near it. This module never decides
// whether to hold. It answers a narrower question about a document that has
// ALREADY failed the byte check — is the difference confined to a region we
// have declared volatile? — so an operator is told which kind of drift they
// are looking at instead of being handed a hash and a website.
//
// WHY THIS EXISTS
//
// champion-news's terms page (TownNews Blox) renders the paper's own most-read
// and most-commented article lists into the same document as the terms. Its
// bytes change whenever the paper publishes: archived digests differ at nearly
// every Wayback snapshot through 2026. Re-approving it re-holds it within
// days, forever, and an operator who re-approves weekly without reading is a
// gate that has been switched off without anyone deciding to switch it off.
//
// WHAT WAS REJECTED, AND WHY IT MATTERS
//
// 1. Hashing the extracted TEXT instead of the bytes. Does not work here: the
//    volatile headlines are prose, not markup, so they survive extraction. It
//    also puts an HTML parser inside the contract, where a parser bug becomes
//    a silent PASS rather than a noisy hold.
// 2. Diffing line by line and classifying each changed line as volatile or
//    not. Broken twice over. A newly published headline cannot appear in the
//    old version, so "present in both" rejects every real churn; and lines
//    carry no DOM coordinates, so a short boilerplate line ("Effective Date:")
//    appearing in both a widget and the legal body could explain away a real
//    deletion.
//
// 3. Pointing terms_url at a clean print or JSON view of the same page, which
//    would have kept plain byte hashing and needed none of this. Ruled out by
//    measurement on 2026-08-25: the canonical URL serves 200 and ~183KB, while
//    ?mode=print, ?print=1, ?template=print, ?_format=json, ?mode=amp,
//    /site/terms.amp.html and /site/print/terms.html all return HTTP 429 "Too
//    Many Requests" with a 68-byte body — including in the same run, seconds
//    after the canonical URL succeeded. Whether the edge is refusing
//    non-canonical URLs or refusing cache misses is not something we can tell
//    from outside, and probing further to find out would mean hammering a
//    publisher we scrape under a politeness rule. Seven forms tried, none
//    reachable: there is no clean endpoint to point at.
//
// So: remove the volatile subtree, canonicalise what is LEFT, and require it
// to be identical to the same computation over the version a human actually
// read. Not the previous week's — a redesign that migrates a clause into a
// widget over several deploys would pass every single week-on-week step.

import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export interface TermsScope {
	/** The element holding the terms themselves. */
	select: string;
	/** Subtrees INSIDE `select` that change without the terms changing. */
	volatile?: string;
	/**
	 * A phrase from the approved terms that must survive the reduction.
	 *
	 * This is the guard against a parser swallowing the legal body into the
	 * volatile subtree — an unclosed tag inside a widget is enough, and on this
	 * very page the sidebar is already nested inside the terms article, so the
	 * containment is not what the markup looks like it should be. If the terms
	 * vanish into the region being removed, the anchor vanishes with them.
	 */
	anchor: string;
	/**
	 * The smallest canonical length that can still be the whole terms.
	 *
	 * The anchor catches a scope that stops matching the terms. It does not
	 * catch a scope that goes too broad and strips them, because then BOTH
	 * versions reduce to the same hollow skeleton: equal to each other, equal
	 * to nothing worth comparing, and a ratio between them of exactly 1. Only a
	 * number fixed outside the documents can see that, so this is set from the
	 * measured length of the approved version and changing it means a human
	 * looked at the terms again.
	 */
	minLength: number;
}

export interface ScopeReading {
	digest: string;
	/** Length of the reduced terms text, which is what minLength gates on. */
	length: number;
	text: string;
	/**
	 * Link targets, in document order. Part of the canonical form, and returned
	 * separately so an operator asked to certify they read the terms can be
	 * shown the destinations too — a retargeted link is one of the changes this
	 * catches, and it is invisible in the text alone.
	 */
	hrefs: string[];
}

export type ScopeResult =
	| ({ ok: true } & ScopeReading)
	| { ok: false; reason: string };

/**
 * Reduces a document to its non-volatile terms, as text plus link targets.
 *
 * Hrefs are part of the canonical form because text alone is blind to a link
 * that keeps its wording and changes its destination — "Acceptable Use Policy"
 * pointed at a new revision is a terms change that reads as no change.
 */
export function readNonVolatile(html: string, scope: TermsScope): ScopeResult {
	let $: cheerio.CheerioAPI;
	try {
		$ = cheerio.load(html);
	} catch (err) {
		return { ok: false, reason: `could not parse the document (${err})` };
	}

	// The root is found and counted BEFORE anything is removed. Removing first
	// lets the volatile selector decide how many roots there are: a mis-scoped
	// one that happened to match a second `select` element would delete it, drop
	// the count back to 1, and slip past the ambiguity guard below — into a
	// "volatile-only" verdict that --attest can act on.
	const root = $(scope.select);
	if (root.length === 0) {
		return { ok: false, reason: `scope selector matched nothing` };
	}
	// More than one match is ambiguity, not abundance. The terms live in one
	// container, and a template that suddenly has two is a change worth a human.
	if (root.length > 1) {
		return {
			ok: false,
			reason: `scope selector matched ${root.length} elements; expected exactly one`,
		};
	}

	// Both removals are scoped to the root, which is also what `volatile`
	// documents itself as: subtrees INSIDE `select`. Nothing outside the root
	// reaches .text() anyway.
	//
	// Script and style go because cheerio's .text() concatenates every
	// descendant text node, INCLUDING the contents of those elements — leaving
	// them in puts CSS rules and JS source into the canonical form, so a rebuilt
	// asset id or a restyled button would read as a change to someone's terms.
	//
	// What this does NOT do is defend against CSS cloaking. A clause hidden with
	// display:none is still in .text() whether or not the stylesheet is removed,
	// and no text extractor can see that it is invisible. That would need a
	// renderer, which is a different project; the raw bytes are archived either
	// way, so the evidence survives even though this check cannot use it.
	root.find("script, style").remove();
	if (scope.volatile) root.find(scope.volatile).remove();

	const text = root.text().replace(/\s+/g, " ").trim();
	if (!text.includes(scope.anchor)) {
		return {
			ok: false,
			reason:
				"the anchor phrase is absent from the non-volatile text — the terms may have been " +
				"removed, rewritten, or swallowed into the volatile region",
		};
	}

	const hrefs = root
		.find("a[href]")
		.map((_i, a) => $(a).attr("href"))
		.get();
	// The floor measures the TEXT, not the canonical form. Canonical includes
	// the href list, and a nav-heavy leftover can carry enough link targets to
	// clear the floor while the terms themselves have collapsed to nothing —
	// which is the exact case the floor exists to catch.
	if (text.length < scope.minLength) {
		return {
			ok: false,
			reason:
				`the non-volatile text is ${text.length} chars, below the ${scope.minLength} ` +
				"a whole terms document should reach — the scope is probably stripping the terms themselves",
		};
	}
	const canonical = `${text}\n--hrefs--\n${hrefs.join("\n")}`;
	return {
		ok: true,
		digest: createHash("sha256").update(canonical).digest("hex"),
		length: text.length,
		text,
		hrefs,
	};
}

export type DriftVerdict =
	/**
	 * The two reduced readings are identical: the terms read the same once the
	 * declared volatile region, script and style are removed. That is weaker
	 * than "only the volatile region moved" — whitespace, attributes other than
	 * href, and anything outside the scope are not compared at all.
	 */
	| { verdict: "volatile-only"; digest: string; text: string }
	/** The terms themselves differ. */
	| { verdict: "terms-changed"; before: ScopeReading; after: ScopeReading }
	/** Not answerable. Always treated as a hold by the caller. */
	| { verdict: "indeterminate"; reason: string };

/**
 * Compares an observed document against the one a human actually read.
 *
 * `anchorHtml` must be the human-anchored version — the last one signed off in
 * full — not last week's. Comparing consecutive versions lets a slow migration
 * pass one indistinguishable step at a time.
 */
export function classifyDrift(
	anchorHtml: string,
	observedHtml: string,
	scope: TermsScope,
): DriftVerdict {
	const before = readNonVolatile(anchorHtml, scope);
	if (!before.ok) {
		return {
			verdict: "indeterminate",
			reason: `the approved version could not be read: ${before.reason}`,
		};
	}
	const after = readNonVolatile(observedHtml, scope);
	if (!after.ok) {
		return {
			verdict: "indeterminate",
			reason: `the observed version could not be read: ${after.reason}`,
		};
	}

	if (before.digest === after.digest) {
		return {
			verdict: "volatile-only",
			digest: after.digest,
			text: after.text,
		};
	}
	return { verdict: "terms-changed", before, after };
}
