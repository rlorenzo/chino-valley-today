// The gate path shared by every Tier B generator: generate -> normalize
// citations -> Gate 1 (deterministic validators) -> one keep-best repair pass ->
// createPost -> Gate 2 (cross-family judge) -> publish/hold routing.
//
// recap.ts and business-tracker.ts ran byte-identical copies of this, 158
// duplicated lines across 4 clone groups. They differ only in what is passed in:
// the prompt body, the slug/title, the post type, and (for the business
// narrative) an extra paragraph of repair guidance about the proper-name gate.
//
// Keeping this in one place matters beyond tidiness: the gates are the editorial
// safety mechanism, and a fix applied to one copy but not the other would mean
// two different definitions of "safe to publish".
import type { Db } from "../db/index.ts";
import { validateDraft } from "../gates/validators.ts";
import { chat } from "../llm/client.ts";
import type { MeetingBundle } from "./bundle.ts";
import { anyContentFlag, isTierC, judgeDraft } from "./judge.ts";
import {
	createPost,
	type NewPost,
	type Tier,
	transitionPost,
} from "./posts.ts";

// The generator wobbles between citation syntaxes across samples ([url] vs
// [label](url)). A bare bracketed URL is an unambiguous citation — normalize it
// to the required markdown-link syntax rather than holding a good draft over
// formatting. Gates still verify the URL against the allowlist.
export function normalizeCitations(md: string): string {
	return md
		.replace(
			/\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g,
			(_m, _a, b) => `[source](${b})`,
		)
		.replace(
			/\[(https?:\/\/[^\]\s]+)\](?!\()/g,
			(_m, url) => `[source](${url})`,
		);
}

export interface GatedRunOptions {
	db: Db;
	// BusinessBundle extends MeetingBundle, so both generators pass through here.
	bundle: MeetingBundle;
	// Already-rendered prompt body; each generator renders its own bundle shape.
	promptBody: string;
	generatorSystem: string;
	slug: string;
	title: string;
	postType: NewPost["postType"];
	tier: Tier;
	meetingDate?: string;
	// Appended to the repair instructions. business-tracker adds proper-name
	// guidance here because its corpus is record-derived and fuses capitalized
	// words more often.
	repairGuidance?: string;
}

// Terminates the process on the hold/skip paths, exactly as the two inlined
// copies did — these run as one-shot CLI entry points, not as library calls.
export async function runGatedPipeline(o: GatedRunOptions): Promise<void> {
	const { db, bundle } = o;

	console.log("Generating draft (Tier B, extractive contract)...");
	const gen = await chat(
		"generator",
		[
			{ role: "system", content: o.generatorSystem },
			{ role: "user", content: o.promptBody },
		],
		{ maxTokens: 4096 },
	);

	let draftMd = normalizeCitations(gen.content.trim());
	console.log(
		`Draft: ${draftMd.length} chars from ${gen.model} (${JSON.stringify(gen.usage ?? {})})`,
	);

	// Gate 1 — deterministic validators (fail = hold, no LLM judge needed).
	const runGate1 = () =>
		validateDraft({
			bodyMd: draftMd,
			allowedUrls: bundle.allowedUrls,
			inputCorpus: bundle.inputCorpus,
		});
	let gateReport = runGate1();
	console.log(
		`Gate 1: ${gateReport.pass ? "PASS" : `FAIL (${gateReport.failures.length} failures)`}`,
	);

	// One repair pass: feed the deterministic failures back to the generator,
	// then re-gate. Still failing after that -> held for human review.
	if (!gateReport.pass) {
		console.log(
			"Repair pass: sending Gate 1 failures back to the generator...",
		);
		// Slim payload: the repair only needs the draft, the failures, and the
		// citable URL list — resending the full bundle costs ~75k tokens and trips
		// per-minute rate limits when it follows the generation call.
		const repair = await chat(
			"generator",
			[
				{ role: "system", content: o.generatorSystem },
				{
					role: "user",
					content:
						"A draft you wrote failed deterministic validation. Fix ONLY the issues listed below and change " +
						'nothing else. If a link URL is "not in the allowed source list", replace it with the closest URL ' +
						'that IS in the citable list below, copied character-for-character. If a number "does not appear in ' +
						'the input corpus", remove that claim entirely (you do not have the sources in this message — do not ' +
						"guess a replacement number). " +
						(o.repairGuidance ?? "") +
						'If a block "has no citation link", add a link from the citable list ' +
						"that the surrounding claims already use, or delete the block. Return the complete corrected draft " +
						"in the same format.\n\n" +
						`Citable URLs:\n${bundle.allowedUrls.map((u) => `- ${u}`).join("\n")}\n\n` +
						`Failures:\n${gateReport.failures.map((f) => `- [${f.gate}] ${f.detail}`).join("\n")}\n\n` +
						`DRAFT:\n\n${draftMd}`,
				},
			],
			{ maxTokens: 4096 },
		);
		const originalDraft = draftMd;
		const originalReport = gateReport;
		draftMd = normalizeCitations(repair.content.trim());
		gateReport = runGate1();
		console.log(
			`Gate 1 after repair: ${gateReport.pass ? "PASS" : `FAIL (${gateReport.failures.length} failures)`}`,
		);
		// A repair that makes things worse gets discarded — hold the better draft.
		if (
			!gateReport.pass &&
			gateReport.failures.length >= originalReport.failures.length
		) {
			console.log(
				"Repair did not improve the draft; keeping the original for review.",
			);
			draftMd = originalDraft;
			gateReport = originalReport;
		}
	}

	const post = createPost(db, {
		slug: o.slug,
		postType: o.postType,
		tier: o.tier,
		title: o.title,
		bodyMd: draftMd,
		...(o.meetingDate ? { meetingDate: o.meetingDate } : {}),
		sources: bundle.allowedUrls,
		// The bundle knows which source it was built from; topic filing reads
		// that rather than guessing from the recap's title.
		sourceKeys: [bundle.sourceKey],
	});
	console.log(`Post ${o.slug}: ${post.outcome}`);
	if (post.outcome === "skipped") {
		console.log(
			"Slug already published/rejected — not regenerating over a human decision.",
		);
		process.exit(0);
	}

	if (!gateReport.pass) {
		transitionPost(db, o.slug, "held", {
			heldReason: `gate1: ${gateReport.failures.map((f) => f.gate).join(",")}`,
			gates: gateReport,
		});
		console.log("HELD at Gate 1. Failures:");
		for (const f of gateReport.failures.slice(0, 10))
			console.log(`  [${f.gate}] ${f.detail}`);
		process.exit(0);
	}

	// Gate 2 — cross-family LLM judge.
	console.log("Gate 2: judging (cross-family model)...");
	const verdict = await judgeDraft(draftMd, bundle);
	console.log(
		`Judge: ${verdict.overall}, faithfulness ${verdict.faithfulness_score}, flags: ${
			Object.entries(verdict.flags)
				.filter(([, v]) => v)
				.map(([k]) => k)
				.join(",") || "none"
		}`,
	);

	if (isTierC(verdict)) {
		// Tier C content: human always, regardless of faithfulness. For license
		// events this is expected rather than a defect — they name licensees
		// (public record, allowed as input), so a private_individual flag here is
		// the designed protection working.
		db.raw.prepare("UPDATE posts SET tier = ? WHERE slug = ?").run("C", o.slug);
		transitionPost(db, o.slug, "held", {
			heldReason: "tierC: judge content flags",
			gates: gateReport,
			judge: verdict,
		});
		console.log("HELD as Tier C (content flags require human review).");
	} else if (verdict.overall !== "pass" || anyContentFlag(verdict)) {
		transitionPost(db, o.slug, "held", {
			heldReason: `gate2: ${verdict.reasons.slice(0, 3).join("; ")}`,
			gates: gateReport,
			judge: verdict,
		});
		console.log("HELD at Gate 2.");
	} else {
		transitionPost(db, o.slug, "published", {
			gates: gateReport,
			judge: verdict,
		});
		console.log(
			`PUBLISHED (auto, clean pass) -> content/published/${o.slug}.md`,
		);
	}
}
