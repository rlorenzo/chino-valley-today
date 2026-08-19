// Deterministic text truncation to sentence boundaries for secondary press teasers.
// Enforces EDITORIAL.md copyright & excerpt limits (≤ 280 chars and ≤ 40 words).

import * as cheerio from "cheerio";

// Abbreviations whose trailing period is not a sentence end. Needed because
// Intl.Segmenter's sentence granularity breaks on every one of them
// ("Mayor Dr." | "Jane Doe met with U.S." | "officials on St." | ...), which
// would truncate a teaser mid-clause.
const ABBREVIATIONS = new Set([
	"mr.",
	"mrs.",
	"ms.",
	"dr.",
	"prof.",
	"sr.",
	"jr.",
	"inc.",
	"co.",
	"corp.",
	"ltd.",
	"u.s.",
	"u.s.a.",
	"st.",
	"ave.",
	"blvd.",
	"rd.",
	"ct.",
	"ste.",
	"apt.",
	"no.",
	"vs.",
	"e.g.",
	"i.e.",
	"etc.",
	"jan.",
	"feb.",
	"mar.",
	"apr.",
	"aug.",
	"sept.",
	"oct.",
	"nov.",
	"dec.",
]);

/**
 * Strips any markup and decodes HTML entities, collapsing runs of whitespace.
 * Delegates to cheerio rather than a hand-written entity table so the full
 * named/numeric entity set is covered, not just the dozen we thought to list.
 */
export function cleanPlainText(text: string): string {
	return cheerio.load(text).text().replace(/\s+/g, " ").trim();
}

/**
 * Splits text into candidate sentences while preserving abbreviations and ellipses.
 */
export function splitSentences(text: string): string[] {
	const cleaned = cleanPlainText(text);
	if (!cleaned) return [];

	const sentences: string[] = [];
	let current = "";

	// Match potential sentence breaks: period, exclamation mark, or question mark
	// followed by quote marks/brackets/whitespace or end of string.
	const tokens = cleaned.split(/(\s+)/);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		current += token;

		const trimmed = current.trim();
		// Check if token ends with sentence-ending punctuation
		const endMatch = token.match(/([.!?]["'”’»]?)$/);
		if (endMatch) {
			const wordOnly = token.replace(/["'”’»]/g, "").toLowerCase();
			// If it's an abbreviation like Mr. or U.S., don't break
			if (ABBREVIATIONS.has(wordOnly)) {
				continue;
			}
			// If it ends with ellipsis ..., don't break yet unless at end
			if (token.endsWith("...") || token.endsWith("…")) {
				continue;
			}
			sentences.push(trimmed);
			current = "";
		}
	}

	const remaining = current.trim();
	if (remaining) {
		sentences.push(remaining);
	}

	return sentences;
}

/**
 * Truncates text to complete sentence boundaries within maxChars (default 280)
 * and maxWords (default 40). Returns null if the first sentence exceeds caps.
 */
export function truncateToSentenceBoundary(
	text: string | null | undefined,
	maxChars = 280,
	maxWords = 40,
): string | null {
	if (!text) return null;
	const sentences = splitSentences(text);
	if (sentences.length === 0) return null;

	let accumulated = "";

	for (const sentence of sentences) {
		const candidate = accumulated ? `${accumulated} ${sentence}` : sentence;
		const charCount = candidate.length;
		const wordCount = candidate.split(/\s+/).filter(Boolean).length;

		if (charCount <= maxChars && wordCount <= maxWords) {
			accumulated = candidate;
		} else {
			break;
		}
	}

	return accumulated || null;
}
