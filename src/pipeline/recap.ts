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
import { GENERATOR_SYSTEM } from "./recap-prompt.ts";

const args = process.argv.slice(2);
const db = openDb();

if (args.length === 0) {
	const targets = listRecapTargets(db);
	if (targets.length === 0) {
		console.log(
			"No recap targets available (need agenda items, minutes, or transcript segments for a meeting date).",
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
	`Bundle ${bundle.targetKey}: ${bundle.agendaItems.length} agenda items, ${bundle.votes.length} votes, ${bundle.minutesItems.length} minutes items, ${bundle.transcriptSegments.length} transcript segments, ${bundle.allowedUrls.length} citable URLs`,
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
