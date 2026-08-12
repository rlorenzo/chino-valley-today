// Gate 2: LLM judge on a different model FAMILY than the generator
// (uncorrelated failure modes). Returns a structured verdict; any flag or
// faithfulness failure routes the draft to held/.
import { chat, parseJsonResponse } from '../llm/client.ts';
import type { MeetingBundle } from './bundle.ts';
import { renderBundleForPrompt } from './bundle.ts';

export interface JudgeVerdict {
  overall: 'pass' | 'fail';
  faithfulness_score: number; // 0..1
  claims: Array<{
    text: string;
    verdict: 'supported' | 'unsupported' | 'distorted';
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
}

export function anyContentFlag(v: JudgeVerdict): boolean {
  return Object.values(v.flags).some(Boolean);
}

// Flags that force Tier C (human always, judge cannot override the hold).
export function isTierC(v: JudgeVerdict): boolean {
  return v.flags.private_individual || v.flags.minor || v.flags.crime || v.flags.personnel || v.flags.legal_matter;
}

const JUDGE_SYSTEM = `You are a strict fact-checking judge for a local news pipeline. You receive a DRAFT article and the SOURCE MATERIALS it was generated from. Your verdict gates automatic publication; when uncertain, fail the claim.

Evaluate:
1. Faithfulness: break the draft into individual claims. For each claim decide: supported (stated in the sources, cited correctly), unsupported (not in the sources), or distorted (in the sources but meaning changed: wrong number, wrong attribution, overstated certainty, garbled name).
2. Content flags (true/false each): allegation (accusations against anyone), crime (crime or law-enforcement content), private_individual (names or identifies any private person - officials acting officially do not count), minor (any person under 18), personnel (public-employee discipline/hiring disputes), characterization (opinion, motive, tone, or "sides" beyond quoted words), legal_matter (litigation, claims, settlements).

Return ONLY a JSON object:
{"overall":"pass"|"fail","faithfulness_score":0.0-1.0,"claims":[{"text":"...","verdict":"supported"|"unsupported"|"distorted","source_url":"...","reason":"..."}],"flags":{"allegation":false,"crime":false,"private_individual":false,"minor":false,"personnel":false,"characterization":false,"legal_matter":false},"reasons":["..."]}

overall = "fail" if ANY claim is unsupported or distorted, or faithfulness_score < 0.9.`;

export async function judgeDraft(draftMd: string, bundle: MeetingBundle): Promise<JudgeVerdict> {
  const res = await chat(
    'judge',
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: `SOURCE MATERIALS:\n\n${renderBundleForPrompt(bundle)}\n\n---\n\nDRAFT:\n\n${draftMd}`,
      },
    ],
    { jsonObject: true, maxTokens: 8192 }
  );
  const v = parseJsonResponse<JudgeVerdict>(res.content);
  // Defensive normalization — a malformed verdict must fail closed, not open.
  if (v.overall !== 'pass' && v.overall !== 'fail') v.overall = 'fail';
  if (typeof v.faithfulness_score !== 'number' || Number.isNaN(v.faithfulness_score)) v.faithfulness_score = 0;
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
