// Gate 2: LLM judge on a different model FAMILY than the generator
// (uncorrelated failure modes). Returns a structured verdict; any flag or
// faithfulness failure routes the draft to held/.
import { chat, parseJsonResponse } from "../llm/client.ts";
import type { MeetingBundle } from "./bundle.ts";
import { renderBundleForPrompt } from "./bundle.ts";

// The judge gets all agenda items and votes, but only the transcript segments
// the draft actually cites (±1 neighbor for context) — a 397B judge over the
// full transcript is slow and expensive without adding rigor: uncited claims
// fail Gate 1 before the judge ever runs, so every claim it must verify
// already points at a specific source.
function bundleForJudge(bundle: MeetingBundle, draftMd: string): MeetingBundle {
	const cited = new Set<string>();
	for (const m of draftMd.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g))
		cited.add(m[1]);
	const keep = new Set<number>();
	bundle.transcriptSegments.forEach((seg, i) => {
		if (cited.has(seg.sourceUrl)) {
			keep.add(i - 1);
			keep.add(i);
			keep.add(i + 1);
		}
	});
	const transcriptSegments = bundle.transcriptSegments.filter((_, i) =>
		keep.has(i),
	);
	return { ...bundle, transcriptSegments };
}

export interface JudgeVerdict {
	overall: "pass" | "fail";
	faithfulness_score: number; // 0..1
	claims: Array<{
		text: string;
		verdict: "supported" | "unsupported" | "distorted";
		source_url?: string;
		reason?: string;
	}>;
	flags: {
		allegation: boolean;
		crime: boolean;
		private_individual: boolean;
		minor: boolean;
		personnel: boolean;
		characterization: boolean;
		legal_matter: boolean;
	};
	reasons: string[];
	judged_by?: string;
}

export function anyContentFlag(v: JudgeVerdict): boolean {
	return Object.values(v.flags).some(Boolean);
}

// Flags that force Tier C (human always, judge cannot override the hold).
export function isTierC(v: JudgeVerdict): boolean {
	return (
		v.flags.private_individual ||
		v.flags.minor ||
		v.flags.crime ||
		v.flags.personnel ||
		v.flags.legal_matter
	);
}

const JUDGE_SYSTEM = `You are a strict fact-checking judge for a local news pipeline. You receive a DRAFT article and the SOURCE MATERIALS it was generated from. Your verdict gates automatic publication; when uncertain, fail the claim.

Evaluate:
1. Faithfulness: break the draft into individual claims. For each claim decide: supported (stated in the sources, cited correctly), unsupported (not in the sources), or distorted (in the sources but meaning changed: wrong number, wrong attribution, overstated certainty, garbled name).
2. Content flags (true/false each): allegation (accusations against anyone), crime (crime or law-enforcement content), private_individual (names or identifies any private person - officials acting officially do not count), minor (any person under 18), personnel (public-employee discipline/hiring disputes), characterization (opinion, motive, tone, or "sides" beyond quoted words), legal_matter (litigation, claims, settlements).

Return ONLY a JSON object:
{"overall":"pass"|"fail","faithfulness_score":0.0-1.0,"claims":[{"text":"...","verdict":"supported"|"unsupported"|"distorted","source_url":"...","reason":"..."}],"flags":{"allegation":false,"crime":false,"private_individual":false,"minor":false,"personnel":false,"characterization":false,"legal_matter":false},"reasons":["..."]}

overall = "fail" if ANY claim is unsupported or distorted, or faithfulness_score < 0.9.`;

export async function judgeDraft(
	draftMd: string,
	bundle: MeetingBundle,
): Promise<JudgeVerdict> {
	const messages = [
		{ role: "system" as const, content: JUDGE_SYSTEM },
		{
			role: "user" as const,
			content: `SOURCE MATERIALS:\n\n${renderBundleForPrompt(bundleForJudge(bundle, draftMd))}\n\n---\n\nDRAFT:\n\n${draftMd}`,
		},
	];
	const opts = { jsonObject: true, maxTokens: 8192, timeoutMs: 900_000 };
	let res;
	try {
		res = await chat("judge", messages, opts);
	} catch (err) {
		console.log(
			`Primary judge unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}); using backup judge.`,
		);
		res = await chat("judge_backup", messages, opts);
	}
	const v = parseJsonResponse<JudgeVerdict>(res.content);
	v.judged_by = res.model;
	// Defensive normalization — a malformed verdict must fail closed, not open.
	if (v.overall !== "pass" && v.overall !== "fail") v.overall = "fail";
	if (
		typeof v.faithfulness_score !== "number" ||
		Number.isNaN(v.faithfulness_score)
	)
		v.faithfulness_score = 0;
	v.claims ??= [];
	v.reasons ??= [];
	v.flags = {
		allegation: !!v.flags?.allegation,
		crime: !!v.flags?.crime,
		private_individual: !!v.flags?.private_individual,
		minor: !!v.flags?.minor,
		personnel: !!v.flags?.personnel,
		characterization: !!v.flags?.characterization,
		legal_matter: !!v.flags?.legal_matter,
	};
	return v;
}
