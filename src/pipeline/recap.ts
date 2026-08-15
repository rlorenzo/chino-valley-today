// Tier B meeting recap: generate -> Gate 1 (deterministic validators) ->
// Gate 2 (cross-family LLM judge) -> route to published/ or held/.
//
//   node src/pipeline/recap.ts                    list available targets
//   node src/pipeline/recap.ts <targetKey>        generate + gate + route one recap
//
import { openDb } from "../db/index.ts";
import {
	assembleBundle,
	listRecapTargets,
	renderBundleForPrompt,
} from "./bundle.ts";
import { runGatedPipeline } from "./gate-run.ts";

const GENERATOR_SYSTEM = `You write meeting recaps for Chino Valley Today, a local news brief for Chino and Chino Hills, CA. You are extractive, not creative: you may state ONLY facts present in the provided source materials.

Hard rules (violations are rejected by machine gates downstream):
1. Every paragraph and every fact-bearing list item ends with one or more INLINE markdown links: [short label](full URL copied EXACTLY from the citable source list). NEVER cite with shorthand — no [S1], no [1], no footnotes; a bare reference tag is not a citation and the draft will be rejected. Cite the most specific source for each claim (agenda item permalink for agenda facts, timestamped transcript URL for spoken material; vote claims cite the vote's own source link).
2. Numbers (votes, dollar amounts, dates, times, addresses) appear exactly as written in the sources - never compute, convert, or estimate.
3. Names: use a person's name ONLY if it appears in agenda items or recorded votes. The transcript is machine-generated and garbles names - if a name appears only in the transcript, refer to the speaker by role instead ("a resident", "a staff member"). Never guess spellings.
4. No characterization: no motives, tone, "sides", or adjectives of controversy. For contested items: what was decided, recorded votes, and direct quotes only.
5. If the materials do not answer a question a reader would have, omit it - do not infer.

Format: markdown. Start with a one-paragraph lede (what happened, when, which body). Then 2-5 short sections for the most consequential items. ### headings must be verbatim excerpts of the agenda item title (truncation is fine, re-wording and re-capitalizing are not - an invented Title Case phrase reads as a proper name and fails the name gate). End with a "Votes" section if recorded votes are present. 300-600 words. No title line - the pipeline adds it.`;

const args = process.argv.slice(2);
const db = openDb();

if (args.length === 0) {
	const targets = listRecapTargets(db);
	if (targets.length === 0) {
		console.log(
			"No recap targets available (need agenda items or transcript segments for a meeting date).",
		);
	} else {
		console.log("Available recap targets:");
		for (const t of targets) {
			console.log(
				`  ${t.targetKey}  ${t.bodyName}  ${JSON.stringify(t.counts)}`,
			);
		}
		console.log("\nGenerate one: node src/pipeline/recap.ts <targetKey>");
	}
	process.exit(0);
}

const [sourceKey, isoDate] = args[0].split(":");
const bundle = assembleBundle(db, sourceKey, isoDate ?? "");
if (!bundle) {
	console.error(`No bundle for ${args[0]} — run with no args to list targets.`);
	process.exit(1);
}

console.log(
	`Bundle ${bundle.targetKey}: ${bundle.agendaItems.length} agenda items, ${bundle.votes.length} votes, ${bundle.transcriptSegments.length} transcript segments, ${bundle.allowedUrls.length} citable URLs`,
);

const slugBody = bundle.bodyName
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, "-")
	.replace(/^-|-$/g, "");
const slug = `${bundle.meetingDate}-${slugBody}-recap`;
const title = `Recap: ${bundle.bodyName} meeting of ${bundle.meetingDate}`;

await runGatedPipeline({
	db,
	bundle,
	promptBody: renderBundleForPrompt(bundle),
	generatorSystem: GENERATOR_SYSTEM,
	slug,
	title,
	postType: "meeting_recap",
	tier: "B",
	meetingDate: bundle.meetingDate,
});
