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
import type { GateFailure, GateReport } from "../gates/validators.ts";
import { validateDraft } from "../gates/validators.ts";
import { chat } from "../llm/client.ts";
import type { MeetingBundle } from "./bundle.ts";
import { anyContentFlag, isTierC, judgeDraft } from "./judge.ts";
import {
	createPost,
	type NewPost,
	normalizeSlug,
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
	// Format checks Gate 1 cannot know about, folded into its report so a
	// failure takes the same repair-then-hold path as a validator failure. The
	// podcast's transcript contract (host turns, headings, length) rides here.
	extraChecks?: (draftMd: string) => GateFailure[];
	// Last step before a clean-pass publish: extra frontmatter fields to write
	// onto the post, produced from the final draft. The podcast renders its
	// audio here, which is why a throw holds the post rather than publishing a
	// transcript with no episode behind it.
	beforePublish?: (draftMd: string) => Promise<Partial<NewPost>>;
	// Runs once the post is cleared to publish, immediately before the
	// transition. beforePublish's output may be a public artifact (the podcast's
	// MP3), and a human can reject the post while beforePublish is still
	// running — so anything that makes that artifact reachable belongs here, not
	// there. A throw holds the post instead of publishing it.
	afterPublish?: () => void;
}

// Extra checks join the Gate 1 report rather than sitting beside it, so one
// report is what the repair pass reads, what a hold records, and what the
// dashboard renders.
export function mergeExtraFailures(
	report: GateReport,
	extra: GateFailure[],
): GateReport {
	if (extra.length === 0) return report;
	return { ...report, pass: false, failures: [...report.failures, ...extra] };
}

// The post as it is filed, both times it is filed: once from the draft, and
// again with beforePublish's extra fields. Extracted so the two calls cannot
// drift into writing different posts.
export function gatedPostInput(o: GatedRunOptions, draftMd: string): NewPost {
	return {
		slug: o.slug,
		postType: o.postType,
		tier: o.tier,
		title: o.title,
		bodyMd: draftMd,
		...(o.meetingDate ? { meetingDate: o.meetingDate } : {}),
		sources: o.bundle.allowedUrls,
		// The bundle knows which source it was built from; topic filing reads
		// that rather than guessing from the recap's title.
		sourceKeys: [o.bundle.sourceKey],
	};
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
		mergeExtraFailures(
			validateDraft({
				bodyMd: draftMd,
				allowedUrls: bundle.allowedUrls,
				inputCorpus: bundle.inputCorpus,
			}),
			o.extraChecks?.(draftMd) ?? [],
		);
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
						'If a name "does not appear in the input corpus", write the name exactly as the sources write it ' +
						"or drop the name from the sentence. Do NOT invent a variant, a compound, or a longer " +
						"official-sounding title to get around the failure — a reworded name fails the same check again. " +
						"Never split one source item into two, or merge two into one, while repairing. " +
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

	const post = createPost(db, gatedPostInput(o, draftMd));
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
		// Normalized AND collated the same way getPost() matches, because both
		// halves fail the same way here: matching the caller's raw slug misses
		// the normalized row, and matching case-sensitively misses a legacy row
		// still stored mixed-case before the migration runs. Either miss updates
		// zero rows and leaves the post at its original tier while the hold
		// below still applies — a Tier C post recorded as Tier A.
		db.raw
			.prepare("UPDATE posts SET tier = ? WHERE slug = ? COLLATE NOCASE")
			.run("C", normalizeSlug(o.slug));
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
		if (o.beforePublish) {
			let extra: Partial<NewPost>;
			try {
				extra = await o.beforePublish(draftMd);
			} catch (err) {
				// The draft passed both gates; only the render failed. Held rather
				// than published, because the audio IS the podcast — a transcript
				// with no episode behind it is a broken post, not a partial one.
				const message = err instanceof Error ? err.message : String(err);
				transitionPost(db, o.slug, "held", {
					heldReason: `audio: ${message}`,
					gates: gateReport,
					judge: verdict,
				});
				console.log(`HELD after Gate 2: ${message}`);
				process.exit(0);
			}
			// Rewrites the queued file with the extra frontmatter before the
			// transition moves it into content/published/.
			const written = createPost(db, {
				...gatedPostInput(o, draftMd),
				...extra,
			});
			// beforePublish takes minutes (the audio render) and the dashboard's
			// Reject button stays live the whole time. createPost refuses to touch
			// a rejected or published row, so a "skipped" here is a human decision
			// made mid-render — honor it instead of publishing over the top.
			if (written.outcome === "skipped") {
				console.log(
					"Rejected or published while rendering — not publishing over a human decision.",
				);
				process.exit(0);
			}
		}
		if (o.afterPublish) {
			// Before the transition, not after: `published` is terminal — the next
			// run exits on that row — so a throw here (permissions, disk space)
			// would strand a published post whose MP3 was never promoted, with no
			// path back. Held on the same `audio:` reason the render failure uses,
			// which is what the backlog drain resumes from. Safe this side of the
			// transition because the mid-render rejection check above is the last
			// slow step; nothing can change the row between the two.
			try {
				o.afterPublish();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				transitionPost(db, o.slug, "held", {
					heldReason: `audio: promote failed: ${message}`,
					gates: gateReport,
					judge: verdict,
				});
				console.log(`HELD after Gate 2: promote failed: ${message}`);
				process.exit(0);
			}
		}
		transitionPost(db, o.slug, "published", {
			gates: gateReport,
			judge: verdict,
		});
		console.log(
			`PUBLISHED (auto, clean pass) -> content/published/${o.slug}.md`,
		);
	}
}
