import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft, BUILTIN_ALLOWLIST, type GateInput, type GateFailure } from './validators.ts';

function failuresFor(f: GateFailure[], gate: GateFailure['gate']): GateFailure[] {
  return f.filter((x) => x.gate === gate);
}

const FOOTER =
  '\n\n---\n\n*Generated from public records with automated review; see sources linked above. Corrections: see About page.*\n';

// ---------------------------------------------------------------------------
// Happy path — realistic, drawn from actual Chino Legistar item shapes
// (see data/cvtoday.db items table: agenda_item/vote rows for event 1963).
// ---------------------------------------------------------------------------

const MEETING_URL =
  'https://chino.legistar.com/MeetingDetail.aspx?ID=1963&GUID=FCED2B78-20F3-40ED-B45D-72741543B315';
const ITEM_URL =
  'https://chino.legistar.com/LegislationDetail.aspx?ID=8140814&GUID=18EB2940-969B-4C96-878D-AF735AAD45B2';

const HAPPY_CORPUS = `
CALL TO ORDER
The July 21, 2026, Regular Meeting of the Chino City Council / Successor Agency to the
Redevelopment Agency was called to order at 4:30 pm by Mayor Eunice M. Ulloa in the
Council Chambers.

Establish a Capital project and Award a Professional Services agreement to Van Dyke
Landscape Architects for Irrigation & Landscape Design Services for Ayala Park. Staff
report: the agreement amount is $48,500 for design services at Ayala Park.

Eunice M. Ulloa: AYES
Curtis Burton: AYES
Karen C. Comstock: AYES
Marisela Rendon: AYES
Tom Haughey: AYES
AYES: 5 NOES: 0 - Motion carried.
{"eventItemId":54464,"eventItemTitle":"Establish a Capital project and Award a
Professional Services agreement to Van Dyke Landscape Architects for Irrigation &
Landscape Design Services for Ayala Park.","person":"Eunice M. Ulloa","personId":264,
"vote":"AYES"}
`;

const HAPPY_BODY = `## Chino City Council — July 21, 2026 Recap

The Chino City Council opened its regular meeting at 4:30 p.m. on July 21, 2026, with
Mayor Eunice M. Ulloa presiding. [Meeting agenda](${MEETING_URL})

The council voted 5-0 to award a $48,500 professional services agreement to Van Dyke
Landscape Architects for irrigation and landscape design at Ayala Park. [Item detail](${ITEM_URL})

- [Full agenda packet](${MEETING_URL})
${FOOTER}`;

describe('validateDraft — happy path', () => {
  test('a properly cited draft built from a small real-shaped corpus passes all gates', () => {
    const input: GateInput = {
      bodyMd: HAPPY_BODY,
      allowedUrls: [MEETING_URL, ITEM_URL],
      inputCorpus: HAPPY_CORPUS,
    };
    const report = validateDraft(input);
    assert.equal(report.pass, true, JSON.stringify(report.failures, null, 2));
    assert.equal(report.failures.length, 0);
    assert.ok(report.stats.substantiveBlocks >= 2);
  });
});

// ---------------------------------------------------------------------------
// Gate 1a — citations
// ---------------------------------------------------------------------------

describe('Gate 1a — citations', () => {
  test('fails: substantive paragraph with no link', () => {
    const input: GateInput = {
      bodyMd: `The council approved the new budget after a lengthy discussion.`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the new budget after a lengthy discussion.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'citations').length > 0);
  });

  test('fails: link URL not in allowedUrls (exact-match, no prefix match)', () => {
    const input: GateInput = {
      bodyMd: `The council approved the budget. [Agenda](https://chino.legistar.com/MeetingDetail.aspx?ID=1)`,
      allowedUrls: ['https://chino.legistar.com/MeetingDetail.aspx?ID=1&GUID=X'], // similar but not identical
      inputCorpus: 'The council approved the budget.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    const cite = failuresFor(report.failures, 'citations');
    assert.ok(cite.some((f) => f.detail.includes('not in the allowed source list')));
  });

  test('trailing-slash normalization: URL matches allowedUrls regardless of a single trailing slash', () => {
    const input: GateInput = {
      bodyMd: `The council met. [Agenda](https://example.com/agenda/)`,
      allowedUrls: ['https://example.com/agenda'], // no trailing slash
      inputCorpus: 'The council met.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'citations').length, 0);
  });

  test('list item stating a fact needs its own link (fails without one)', () => {
    const input: GateInput = {
      bodyMd: `Agenda highlights:\n\n- The council approved a $10,000 grant to the library.\n- [Full agenda](https://example.com/agenda)`,
      allowedUrls: ['https://example.com/agenda'],
      inputCorpus: 'The council approved a $10,000 grant to the library.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'citations').length > 0);
  });

  test('pure-link list items are exempt (a bullet that is only a link needs no separate scrutiny)', () => {
    const input: GateInput = {
      bodyMd: `The council discussed the agenda. [Recap](https://example.com/a)\n\n- [Agenda](https://example.com/agenda)\n- [Minutes](https://example.com/minutes)`,
      allowedUrls: ['https://example.com/a', 'https://example.com/agenda', 'https://example.com/minutes'],
      inputCorpus: 'The council discussed the agenda.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'citations').length, 0);
  });

  test('headings and horizontal rules are exempt from the citation requirement', () => {
    const input: GateInput = {
      bodyMd: `## Chino City Council Recap\n\n---\n\nThe council approved the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'citations').length, 0);
  });

  test('disclosure footer content after the final --- is exempt, including from URL and name scanning', () => {
    const input: GateInput = {
      bodyMd: `The council approved the item. [Agenda](https://example.com/a)${FOOTER}`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, true, JSON.stringify(report.failures, null, 2));
  });

  test('a mid-document --- that is NOT the disclosure footer does not exempt what follows it (fail-closed)', () => {
    const input: GateInput = {
      bodyMd: `The council approved the item. [Agenda](https://example.com/a)\n\n---\n\nThe council also approved a second, uncited item.`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item. The council also approved a second item.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'citations').length > 0);
  });

  test('fails: empty draft', () => {
    const report = validateDraft({ bodyMd: '', allowedUrls: [], inputCorpus: '' });
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'citations').some((f) => f.detail.includes('no substantive content')));
  });

  test('fails: draft that is only headings', () => {
    const input: GateInput = {
      bodyMd: `# Chino City Council Recap\n\n## July 21, 2026`,
      allowedUrls: [],
      inputCorpus: 'July 21, 2026',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'citations').some((f) => f.detail.includes('no substantive content')));
  });
});

// ---------------------------------------------------------------------------
// Gate 1b — numeric consistency
// ---------------------------------------------------------------------------

describe('Gate 1b — numeric consistency', () => {
  test('fails: invented dollar amount not in corpus', () => {
    const input: GateInput = {
      bodyMd: `The council awarded a $99,000 contract for street repairs. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council awarded a $48,500 contract for street repairs.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    const numeric = failuresFor(report.failures, 'numeric');
    assert.ok(numeric.some((f) => f.detail.includes('99,000') || f.detail.includes('99000')));
  });

  test('fails: vote tally not corroborated by corpus', () => {
    const input: GateInput = {
      bodyMd: `The council voted 4-1 to approve the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'The council discussed the item at length. Staff recommended approval. Mayor Ulloa called for public comment.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'numeric').some((f) => f.detail.includes('vote tally')));
  });

  test('passes: vote tally corroborated via literal "N-M" substring in corpus even if phrased differently elsewhere', () => {
    const input: GateInput = {
      bodyMd: `The council voted 4-1 to approve the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Motion result: 4-1. Motion carried.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'numeric').length, 0);
  });

  test('passes: reworded date — draft long-form matches corpus ISO form', () => {
    const input: GateInput = {
      bodyMd: `The council will meet on August 12, 2026. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'meeting_date: 2026-08-12',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'numeric').length, 0);
  });

  test('passes: reworded date — draft ISO matches corpus US-slash form', () => {
    const input: GateInput = {
      bodyMd: `The meeting occurred on 2026-08-12. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Posted 8/12/2026 by the City Clerk.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'numeric').length, 0);
  });

  test('fails: a date not present in the corpus in any form', () => {
    const input: GateInput = {
      bodyMd: `The council will meet on August 19, 2026. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'meeting_date: 2026-08-12',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'numeric').some((f) => f.detail.includes('date')));
  });

  test('passes: digit-grouping variant ($1,234,567 in draft vs 1234567 in corpus)', () => {
    const input: GateInput = {
      bodyMd: `The project budget is $1,234,567 for this fiscal year. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'total_budget: 1234567',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'numeric').length, 0);
  });

  test('passes: percentage spelled out in corpus ("42 percent") matches "42%" in draft', () => {
    const input: GateInput = {
      bodyMd: `Water usage dropped 42% compared to last year. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Usage decreased by 42 percent compared to last year.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'numeric').length, 0);
  });

  test('passes: time format equivalence ("6:00 p.m." draft vs "6:00 PM" corpus)', () => {
    const input: GateInput = {
      bodyMd: `The meeting begins at 6:00 p.m. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Meeting time: 6:00 PM in the Council Chambers.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'numeric').length, 0);
  });

  test('fails: small counting number derived from list structure, not literally in corpus (default strict)', () => {
    const input: GateInput = {
      bodyMd: `The council reviewed 3 agenda items during the closed session. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'Item 1: real property negotiations. Item 2: pending litigation. Item 3: personnel matter.',
    };
    const report = validateDraft(input);
    // "1" and "2" are in the corpus as item labels but "3" also happens to be present here
    // (Item 3) — construct a variant with a genuinely absent count to keep the assertion honest.
    const input2: GateInput = {
      bodyMd: `The council reviewed 5 agenda items during the closed session. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'Item 1: real property negotiations. Item 2: pending litigation. Item 3: personnel matter.',
    };
    const report2 = validateDraft(input2);
    assert.equal(report2.pass, false);
    assert.ok(failuresFor(report2.failures, 'numeric').length > 0);
    void report; // input/report retained for readability of the "3 happens to be present" note above
  });
});

// ---------------------------------------------------------------------------
// Gate 1c — proper-name whitelist
// ---------------------------------------------------------------------------

describe('Gate 1c — proper-name whitelist', () => {
  test('fails: invented person name not in corpus', () => {
    const input: GateInput = {
      bodyMd: `Councilmember Jonathan Reyes moved to approve the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Eunice M. Ulloa moved to approve the item. The motion carried.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'proper_names').some((f) => f.detail.includes('Jonathan Reyes')));
  });

  test('fails: garbled name variant (transcript-typo name) even though a similar real name exists in corpus', () => {
    const input: GateInput = {
      bodyMd: `Councilmember Marria Lopez seconded the motion. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Maria Lopez seconded the motion during the regular meeting.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'proper_names').some((f) => f.detail.includes('Marria Lopez')));
  });

  test('passes: titled real name grounded even when the corpus never repeats the title', () => {
    const input: GateInput = {
      bodyMd: `Mayor Eunice M. Ulloa called the meeting to order. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Eunice M. Ulloa called the meeting to order at 4:30 pm.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });

  test('fails: multi-token name must match as a whole sequence, not as separately-grounded words', () => {
    const input: GateInput = {
      bodyMd: `Maria Lopez spoke during public comment. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'Maria attended the budget workshop last spring. The Lopez family runs a bakery on Central Avenue.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'proper_names').some((f) => f.detail.includes('Maria Lopez')));
  });

  test('does not false-positive: prose word does not fuse with an adjacent link label into one name', () => {
    // Regression: first live recap was held on phantom name "LLMDs LLMD" —
    // link-stripping erased the "[" between prose and label, so the
    // whitespace-gap anti-fusion rule never saw a boundary.
    const input: GateInput = {
      bodyMd: `The council confirmed the annual assessments for six LLMDs [LLMD item](https://example.com/a).`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'Adopt Landscape and Lighting Maintenance District (LLMD) Assessment. The six LLMDs cover parkway landscaping citywide.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });

  test('does not false-positive: chained citation links do not fuse with prose or each other', () => {
    // First link is followed by another link (citation position), second by
    // end punctuation — neither label may fuse with the prose before them.
    // The two capitalized runs must NOT be adjacent in the corpus (period-
    // collapsing in corpus normalization would otherwise mask a fusion).
    const input: GateInput = {
      bodyMd: `The assessments were confirmed for six LLMDs [LLMD item](https://example.com/a) [Vote](https://example.com/a).`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'Adopt Landscape and Lighting Maintenance District (LLMD) Assessment was heard. The six LLMDs cover parkway landscaping citywide.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });

  test('fails: hallucinated composite name split across a mid-sentence link boundary (Codex review finding)', () => {
    // "Maria [Lopez](url) spoke" renders to the reader as the name "Maria
    // Lopez". A mid-sentence link label is content, not citation chrome —
    // it must be scanned as one sequence with the adjacent prose, and the
    // composite must fail when only its halves are separately grounded.
    const input: GateInput = {
      bodyMd: `Maria [Lopez](https://example.com/a) spoke during public comment. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'Maria attended the workshop. Councilmember Lopez was absent.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'proper_names').some((f) => f.detail.includes('Maria Lopez')));
  });

  test('fails: garbled name inside a link label is still scanned and caught', () => {
    const input: GateInput = {
      bodyMd: `The board heard the report. [Elise Jukley presentation](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The board heard the report from Elise Buckley during the meeting.',
    };
    const report = validateDraft(input);
    assert.equal(report.pass, false);
    assert.ok(failuresFor(report.failures, 'proper_names').some((f) => f.detail.includes('Elise Jukley')));
  });

  test('does not false-positive: sentence-initial common word is not treated as a name', () => {
    const input: GateInput = {
      bodyMd: `The council approved the item unanimously. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item unanimously.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });

  test('does not false-positive: sentence-initial institutional noun ("Staff recommended...")', () => {
    const input: GateInput = {
      bodyMd: `Staff recommended approval of the contract. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'City staff recommended approval of the contract.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });

  test('does not false-positive: built-in allowlist entries need no corpus grounding', () => {
    const input: GateInput = {
      bodyMd: `Chino Hills City Council will meet in California this Tuesday in August. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'A regular meeting is scheduled for this week.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });

  test('built-in allowlist is non-empty and contains the documented anchors', () => {
    assert.ok(BUILTIN_ALLOWLIST.includes('chino'));
    assert.ok(BUILTIN_ALLOWLIST.includes('chino hills'));
    assert.ok(BUILTIN_ALLOWLIST.includes('city council'));
    assert.ok(BUILTIN_ALLOWLIST.includes('monday'));
    assert.ok(BUILTIN_ALLOWLIST.includes('august'));
    assert.ok(BUILTIN_ALLOWLIST.includes('california'));
  });

  test('headings are excluded from name scanning (title-case headings do not need corpus grounding)', () => {
    const input: GateInput = {
      bodyMd: `## Business License Reform Approved\n\nThe council approved the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item.',
    };
    const report = validateDraft(input);
    assert.equal(failuresFor(report.failures, 'proper_names').length, 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('corpus containing markdown itself does not confuse the gates and is not treated as an allowed URL', () => {
    const input: GateInput = {
      bodyMd: `The council approved the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus:
        'See the [prior release](https://example.com/nr-old) for background. The council approved the item.',
    };
    const report = validateDraft(input);
    // the draft's own citation is fine...
    assert.equal(report.pass, true, JSON.stringify(report.failures, null, 2));

    // ...but a draft that cites the URL merely because it appears as TEXT in the
    // corpus (not in allowedUrls) must still fail — inputCorpus is not a source
    // of citable URLs.
    const input2: GateInput = {
      ...input,
      bodyMd: `The council approved the item. [Prior release](https://example.com/nr-old)`,
    };
    const report2 = validateDraft(input2);
    assert.equal(report2.pass, false);
    assert.ok(failuresFor(report2.failures, 'citations').length > 0);
  });

  test('does not throw on malformed/unterminated markdown links', () => {
    const input: GateInput = {
      bodyMd: `The council approved the item. [Agenda](https://example.com/a\n\nAnother paragraph with [broken link text.`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item.',
    };
    assert.doesNotThrow(() => validateDraft(input));
  });

  test('whitespace-only draft fails the same as an empty draft', () => {
    const report = validateDraft({ bodyMd: '   \n\n  \n', allowedUrls: [], inputCorpus: '' });
    assert.equal(report.pass, false);
  });

  test('report shape: stats is populated and failures carry only documented gate names', () => {
    const report = validateDraft({
      bodyMd: `The council approved the item. [Agenda](https://example.com/a)`,
      allowedUrls: ['https://example.com/a'],
      inputCorpus: 'The council approved the item.',
    });
    assert.equal(typeof report.pass, 'boolean');
    assert.ok(typeof report.stats === 'object');
    for (const f of report.failures) {
      assert.ok(['citations', 'numeric', 'proper_names'].includes(f.gate));
    }
  });
});
