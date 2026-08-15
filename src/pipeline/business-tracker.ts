// Tier B weekly business-tracker narrative: generate -> Gate 1 (deterministic
// validators) -> Gate 2 (cross-family LLM judge) -> route to published/ or
// held/. Synthesizes ABC license events + business-relevant planning items
// for one ISO week. The Tier A listing version is src/tiera/business-tracker.ts;
// this one adds LLM narrative synthesis behind the full gate path.
//
//   node src/pipeline/business-tracker.ts             list available ISO weeks
//   node src/pipeline/business-tracker.ts 2026-W33    generate + gate + route one week
//
import { openDb } from "../db/index.ts";
import {
	assembleBusinessBundle,
	listBusinessWeeks,
	renderBusinessBundleForPrompt,
} from "./bundle.ts";
import { runGatedPipeline } from "./gate-run.ts";
import type { NewPost } from "./posts.ts";

const GENERATOR_SYSTEM = `You write a weekly business tracker for Chino Valley Today, a local news brief for Chino and Chino Hills, CA. Your input is one week of California ABC alcohol-license events and business-relevant city planning items. You are extractive, not creative: you may state ONLY facts present in the provided source materials.

Hard rules (violations are rejected by machine gates downstream):
1. Every paragraph and every fact-bearing list item ends with one or more INLINE markdown links: [short label](full URL copied EXACTLY from the citable source list). NEVER cite with shorthand — no [S1], no [1], no footnotes; a bare reference tag is not a citation and the draft will be rejected.
2. Numbers (license numbers, license types, dates, addresses, case numbers) appear exactly as written in the sources — never compute, convert, or estimate. This includes counts: how many events happened this week is a number YOU would be computing, so never state it in digits or words ("two licenses") — just report each event.
3. Names: use only names that appear in the source records (licensees, dba names, applicants). Never guess spellings, never introduce anyone the records do not name.
4. Connections: you may place two events side by side when they share a premises address or a license number, stating each fact with its own citation. Never assert a cause, an ownership change, or a business outcome the records do not state — "the records show X and Y" is allowed, "X because Y" is not.
5. No characterization: no motives, tone, or adjectives of judgment. A status change is reported as the record states it (e.g. ACTIVE -> REVPEN), with no speculation about why.
6. If the materials do not answer a question a reader would have, omit it — do not infer.

Format: markdown, 100-400 words. A one-paragraph lede (what moved in Chino Valley business activity this week), then a short paragraph or list entry per event or item. Write only about the events themselves — never describe the input materials (do not note that a category of item was absent this week). Do not invent Title Case section headings; if you use ### headings they must be verbatim excerpts of source item titles (truncation is fine, re-wording is not). No title line — the pipeline adds it.`;

// posts.ts's NewPost union predates this post type; the posts table column is
// untyped TEXT, so only the compile-time union needs the assertion.
const POST_TYPE = "business_narrative" as NewPost["postType"];

const args = process.argv.slice(2);
const db = openDb();

if (args.length === 0) {
	const weeks = listBusinessWeeks(db);
	if (weeks.length === 0) {
		console.log(
			"No business-tracker weeks available (need license events or business-relevant planning items).",
		);
	} else {
		console.log("Available business-tracker weeks:");
		for (const w of weeks) {
			console.log(`  ${w.isoWeek}  ${JSON.stringify(w.counts)}`);
		}
		console.log(
			"\nGenerate one: node src/pipeline/business-tracker.ts <ISO-week>",
		);
	}
	process.exit(0);
}

const isoWeek = args[0];
if (!/^\d{4}-W\d{2}$/.test(isoWeek)) {
	console.error(`"${isoWeek}" is not an ISO week (expected e.g. 2026-W33).`);
	process.exit(1);
}

const bundle = assembleBusinessBundle(db, isoWeek);
if (!bundle) {
	console.log(
		`${isoWeek}: nothing to synthesize (no license events or business-relevant planning items).`,
	);
	process.exit(0);
}

console.log(
	`Bundle ${bundle.targetKey}: ${bundle.licenseEvents.length} license events, ${bundle.planningItems.length} planning items, ${bundle.allowedUrls.length} citable URLs`,
);

const slug = `${isoWeek}-business-narrative`;
const title = `Business Tracker Narrative — ${isoWeek}`;

await runGatedPipeline({
	db,
	bundle,
	promptBody: renderBusinessBundleForPrompt(bundle),
	generatorSystem: GENERATOR_SYSTEM,
	slug,
	title,
	postType: POST_TYPE,
	tier: "B",
	// Record-derived corpora fuse adjacent capitalized words more often, so the
	// proper-name gate needs explicit repair guidance here.
	repairGuidance:
		'If a name "does not appear in the input corpus", reword to eliminate ' +
		"that exact capitalized phrase: use names only exactly as the sources write them, and break " +
		"accidental fusions of adjacent capitalized words (a common cause is a capitalized word at the " +
		"start of a sentence directly before a place or agency name). ",
});
