// Tier B meeting recap: generate -> Gate 1 (deterministic validators) ->
// Gate 2 (cross-family LLM judge) -> route to published/ or held/.
//
//   node src/pipeline/recap.ts                    list available targets
//   node src/pipeline/recap.ts <targetKey>        generate + gate + route one recap
//
import { openDb } from '../db/index.ts';
import { chat } from '../llm/client.ts';
import { validateDraft } from '../gates/validators.ts';
import { assembleBundle, listRecapTargets, renderBundleForPrompt } from './bundle.ts';
import { judgeDraft, anyContentFlag, isTierC } from './judge.ts';
import { createPost, transitionPost } from './posts.ts';

const GENERATOR_SYSTEM = `You write meeting recaps for Chino Valley Today, a local news brief for Chino and Chino Hills, CA. You are extractive, not creative: you may state ONLY facts present in the provided source materials.

Hard rules (violations are rejected by machine gates downstream):
1. Every paragraph and every fact-bearing list item ends with one or more markdown links, and every link URL must be copied EXACTLY from the "Citable sources" list. Cite the most specific source for each claim (agenda item permalink for agenda facts, timestamped transcript URL for spoken material).
2. Numbers (votes, dollar amounts, dates, times, addresses) appear exactly as written in the sources - never compute, convert, or estimate.
3. Names: use a person's name ONLY if it appears in agenda items or recorded votes. The transcript is machine-generated and garbles names - if a name appears only in the transcript, refer to the speaker by role instead ("a resident", "a staff member"). Never guess spellings.
4. No characterization: no motives, tone, "sides", or adjectives of controversy. For contested items: what was decided, recorded votes, and direct quotes only.
5. If the materials do not answer a question a reader would have, omit it - do not infer.

Format: markdown. Start with a one-paragraph lede (what happened, when, which body). Then 2-5 short sections for the most consequential items (### headings, verbatim-faithful). End with a "Votes" section if recorded votes are present. 300-600 words. No title line - the pipeline adds it.`;

const args = process.argv.slice(2);
const db = openDb();

if (args.length === 0) {
  const targets = listRecapTargets(db);
  if (targets.length === 0) {
    console.log('No recap targets available (need agenda items or transcript segments for a meeting date).');
  } else {
    console.log('Available recap targets:');
    for (const t of targets) {
      console.log(`  ${t.targetKey}  ${t.bodyName}  ${JSON.stringify(t.counts)}`);
    }
    console.log('\nGenerate one: node src/pipeline/recap.ts <targetKey>');
  }
  process.exit(0);
}

const [sourceKey, isoDate] = args[0].split(':');
const bundle = assembleBundle(db, sourceKey, isoDate ?? '');
if (!bundle) {
  console.error(`No bundle for ${args[0]} — run with no args to list targets.`);
  process.exit(1);
}

console.log(
  `Bundle ${bundle.targetKey}: ${bundle.agendaItems.length} agenda items, ${bundle.votes.length} votes, ${bundle.transcriptSegments.length} transcript segments, ${bundle.allowedUrls.length} citable URLs`
);

console.log('Generating draft (Tier B, extractive contract)...');
const gen = await chat(
  'generator',
  [
    { role: 'system', content: GENERATOR_SYSTEM },
    { role: 'user', content: renderBundleForPrompt(bundle) },
  ],
  { maxTokens: 4096 }
);
const draftMd = gen.content.trim();
console.log(`Draft: ${draftMd.length} chars from ${gen.model} (${JSON.stringify(gen.usage ?? {})})`);

const slugBody = bundle.bodyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const slug = `${bundle.meetingDate}-${slugBody}-recap`;
const title = `Recap: ${bundle.bodyName} meeting of ${bundle.meetingDate}`;

// Gate 1 — deterministic validators (fail = hold, no LLM judge needed).
const gateReport = validateDraft({
  bodyMd: draftMd,
  allowedUrls: bundle.allowedUrls,
  inputCorpus: bundle.inputCorpus,
});
console.log(`Gate 1: ${gateReport.pass ? 'PASS' : `FAIL (${gateReport.failures.length} failures)`}`);

const post = createPost(db, {
  slug,
  postType: 'meeting_recap',
  tier: 'B',
  title,
  bodyMd: draftMd,
  meetingDate: bundle.meetingDate,
  sources: bundle.allowedUrls,
});
console.log(`Post ${slug}: ${post.outcome}`);
if (post.outcome === 'skipped') {
  console.log('Slug already published/rejected — not regenerating over a human decision.');
  process.exit(0);
}

if (!gateReport.pass) {
  transitionPost(db, slug, 'held', {
    heldReason: `gate1: ${gateReport.failures.map((f) => f.gate).join(',')}`,
    gates: gateReport,
  });
  console.log('HELD at Gate 1. Failures:');
  for (const f of gateReport.failures.slice(0, 10)) console.log(`  [${f.gate}] ${f.detail}`);
  process.exit(0);
}

// Gate 2 — cross-family LLM judge.
console.log('Gate 2: judging (cross-family model)...');
const verdict = await judgeDraft(draftMd, bundle);
console.log(
  `Judge: ${verdict.overall}, faithfulness ${verdict.faithfulness_score}, flags: ${
    Object.entries(verdict.flags).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'
  }`
);

if (isTierC(verdict)) {
  // Tier C content: human always, regardless of faithfulness.
  db.raw.prepare('UPDATE posts SET tier = ? WHERE slug = ?').run('C', slug);
  transitionPost(db, slug, 'held', { heldReason: 'tierC: judge content flags', gates: gateReport, judge: verdict });
  console.log('HELD as Tier C (content flags require human review).');
} else if (verdict.overall !== 'pass' || anyContentFlag(verdict)) {
  transitionPost(db, slug, 'held', { heldReason: `gate2: ${verdict.reasons.slice(0, 3).join('; ')}`, gates: gateReport, judge: verdict });
  console.log('HELD at Gate 2.');
} else {
  transitionPost(db, slug, 'published', { gates: gateReport, judge: verdict });
  console.log(`PUBLISHED (auto, clean pass) -> content/published/${slug}.md`);
}
