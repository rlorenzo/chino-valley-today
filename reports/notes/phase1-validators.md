# Phase 1 — Gate 1 deterministic validators

`src/gates/validators.ts` exports `validateDraft(input: GateInput): GateReport`,
implementing the three deterministic gates from PLAN.md's Phase 1 spec:
1a citation coverage, 1b numeric consistency, 1c proper-name whitelist. Fail
= hold for human review. The whole module is dependency-free (no imports)
and pure — no I/O, no DB access — so it is trivial to unit test and to call
from the pipeline wherever a draft + its source set are available.

Design stance throughout: **when a rule is ambiguous, resolve toward
failing.** A false HOLD costs a human a few minutes; a false PASS ships a
hallucination under the paper's name.

## Shared structure: block parsing

Every gate operates on the same block decomposition of `bodyMd`
(`parseBlocks`, private to the module):

- The draft is split on blank lines into blocks.
- A block that is `#`–`######` on a single line is a **heading**.
- A block that is exactly `---`, `***`, or `___` on one line is an **hr**.
- A block whose first line starts with a list marker (`-`, `*`, `+`, or
  `1.`/`1)`) is a **list**; it is exploded into one entry per marker line,
  with any non-marker follow-on lines appended to the preceding item as
  wrapped continuation text. Each item is independently classified as either
  **list-pure-link** (its entire trimmed content, after the marker, is
  nothing but a single markdown link — optionally with one trailing
  `.,;:`) or **list-fact** (anything else).
- Everything else is a **paragraph**.
- **Footer detection:** the LAST hr block in the document is a candidate
  footer boundary. If the concatenated text of every block *after* it
  matches `/generated from public records|corrections:/i` — the hallmark of
  `DISCLOSURE_FOOTER` in `src/pipeline/posts.ts` — that hr block and
  everything after it is reclassified as **footer** and excluded from all
  three gates entirely. If the trailing text does *not* match those
  phrases, the hr block stays a plain (exempt) hr, but whatever follows it
  is gated normally. This is a deliberate fail-closed choice: trusting "any
  trailing `---`" would let a spurious mid-draft divider silently exempt
  real content from every check. A dedicated test
  (`a mid-document --- that is NOT the disclosure footer...`) locks this in.

## Gate 1a — citations

**Rule:** every *substantive* block must contain at least one markdown link
(`[text](url)`), and every link URL found anywhere in the non-footer draft
must be an exact member of `allowedUrls` after normalizing away a single
trailing slash on each side (`https://x/y/` ≡ `https://x/y`) — no
prefix/partial matching.

**Exempt from the "must have a link" requirement** (not substantive):

- headings
- hr blocks
- the footer (see above)
- **list-pure-link** items — a bullet whose entire content is one link (e.g.
  a "Sources:" list entry) is a reference, not a claim. It trivially has a
  link already; the exemption means it also doesn't count toward "the draft
  has substantive content" below.

**Everything else — paragraphs and list-fact items — must have its own
link.** This directly implements the spec's "every list item stating a fact
needs its own link"; a paragraph with three facts and one link at the end
does not satisfy it either, only per-block presence does.

**Whole-draft rule:** if the draft has **zero substantive blocks** (empty
draft, or a draft that is only headings), it fails outright — a draft isn't
"vacuously well-cited" just because it has no content to check.

## Gate 1b — numeric consistency

Runs on `scanText`: paragraph and list-fact blocks only (see "Why headings
and list-pure-link items are excluded from 1b/1c" below), with markdown
links reduced to their visible text (`[Item detail](url)` → `Item detail`)
so a URL's path/query digits or slug words never get scanned as if they were
facts, and bare `https://…` runs stripped outright.

Extraction runs in this order, each pass marking its matched span as
"consumed" so later passes (and the plain-number pass) don't re-flag the
same digits:

1. **Dates** — four patterns: ISO (`2026-08-12`), US slash (`8/12/2026`),
   `Month D[st|nd|rd|th], YYYY`, and `D Month YYYY`, all canonicalized to a
   `YYYY-MM-DD` key. A draft date passes if the **same calendar date**
   appears in the corpus in *any* of those four forms — the corpus doesn't
   have to use the same rendering as the draft. Digit-group boundaries use
   `(?<!\d)`/`(?!\d)` lookaround rather than `\b`, because `\b` does not
   fire between a digit and a following *letter* (both count as `\w`) — a
   plain `\b`-anchored regex misses `2026-08-11` when it's immediately
   followed by `T` in a full ISO-8601 timestamp
   (`2026-08-11T00:25:00.000Z`), which is exactly how `occurred_at` is
   stored throughout the DB. Caught by calibration (see below); real bug,
   now fixed.
2. **Times** — `H:MM` with an optional `am`/`pm`/`a.m.`/`p.m.` marker,
   compared as loose clock-face digits (`6:00`) with the meridiem stripped
   before comparison. `"6:00 p.m."` and `"6:00 PM"` match trivially. This
   is a deliberate simplification — see blind spots.
3. **Vote tallies** (`5-0`, `4-1`) — both halves ≤ 15 (tune `extractTallies`'
   guard for a covered body larger than ~15 seats), and not part of a longer
   hyphen chain (`(?<!\d-)…(?!-\d)`, so `8-12-2026` isn't misread as a
   tally). A tally passes if either the literal substring `"N-M"` appears in
   the corpus, **or** both `N` and `M` independently appear as generic
   numbers in the corpus (handles vote records stored as a roll call plus a
   summary line like `AYES: 5 NOES: 0`, rather than a literal `"5-0"`
   string).
4. **Generic numbers** — `$?\d{1,3}(,\d{3})+(\.\d+)?` or `$?\d+(\.\d+)?`,
   with an optional trailing `%`/`percent`/`per cent`. Comparison strips
   `$`, `,`, `%`, and the percent words, then compares as a `Number` — so
   `$1,234,567` (draft) matches `1234567` or `1234567.00` (corpus), and
   `42%` matches `42 percent`.

**Small counting numbers derived from list structure** (e.g. "three items"
where the draft counts something the corpus never states as a digit): no
special exemption is implemented. **Default strict** — if the digit doesn't
literally appear in the corpus, the gate fails, even if the count is
arithmetically correct. This only applies to digit form; Gate 1b does not
parse spelled-out number words ("three") at all — see blind spots.

## Gate 1c — proper-name whitelist

Runs on the same `scanText` as 1b. No NER dependency; consecutive-capitalized-token
sequences via `[A-Za-z][A-Za-z'-]*` tokenization, split into sentence-like
parts on `.!?` + whitespace or newlines (a name can never span a sentence
boundary — see calibration finding #2 for why this mattered in practice).

**Sequence building:** starting at a capitalized token, extend the sequence
through subsequent capitalized tokens, or through a small connector-word set
(`of`, `de`, `la`, `del`, `da`, `van`, `von`, `der` — e.g. "City of Chino",
"Maria de la Cruz"). **Critically, a join only happens if the text between
the two tokens is pure whitespace** — a colon, comma, dash, or parenthesis
in between stops the sequence. Without this, a markdown bold label like
`**Date:** August` fuses into one bogus candidate `"Date August"` that can
never be grounded (real bug found via calibration, now fixed — see below).
`"and"` and `"the"` are deliberately **not** connectors, so `"Maria Lopez
and Curtis Burton"` reads as two independent names, not one unmatchable
five-word phrase.

**Stripping before the grounding check** (in order):

1. If the sequence's first token is sentence-initial *and* is in
   `SENTENCE_INITIAL_COMMON_WORDS` (generic function words — `the`, `a`,
   `it`, `according`, `however`, … — plus meeting-recap-genre institutional
   nouns that constantly start sentences in this domain — `council`,
   `staff`, `meeting`, `item`, `agenda`, `vote`, `city`, `department`,
   `date`, `time`, `location`, `status`, `type`, `source`, … — see the full
   list in the module), strip it. If nothing remains, the whole sequence is
   exempt (this is how `"The council approved…"` doesn't flag `"The"`).
2. If the (remaining) first token is a role/title word
   (`TITLE_WORDS` — `mayor`, `councilmember`, `superintendent`, `officer`,
   `chief`, `trustee`, `dr`, `mr`, …, plus the two-word `"Council Member"`),
   strip it **regardless of sentence position** — titles occur mid-sentence
   too ("said Councilmember Maria Lopez"). If nothing remains, exempt.

**Grounding:** the remaining phrase is checked, case-insensitively, against
`BUILTIN_ALLOWLIST` (whole-phrase match) and then against `inputCorpus` as a
whitespace-collapsed substring search. Periods are replaced with spaces (not
deleted) before the corpus is normalized, specifically so a token boundary
inside `"Eunice M. Ulloa"` doesn't fuse into `"MUlloa"` and silently break
the match.

`BUILTIN_ALLOWLIST` (documented in full as an exported constant so it's
auditable and directly editable): weekday names, month names (full +
common abbreviations), all 50 US states + DC, `CA`/`US`/`USA`/`United
States`, and a short list of local entities — `Chino`, `Chino Hills`,
`Chino Valley`, `City of Chino[ Hills]`, `San Bernardino[ County]`, `City
Council`, `[Chino[ Hills]] City Council`, `Planning Commission`, `CVUSD`,
`Chino Valley Unified School District`, `Board of Education`, `Chino
Valley Today`, `Alcoholic Beverage Control`, `ABC`, `National Weather
Service`, `NWS`.

**Multi-token names match as a whole sequence, never word-by-word:**
`"Maria Lopez"` must appear as that adjacent phrase in the corpus; having
"Maria" in one sentence and "Lopez" in an unrelated one does not ground it
(a dedicated test locks this in). This is exactly what catches a garbled
transcript name: `"Councilmember Marria Lopez"` strips to `"Marria Lopez"`
after the title, which is not a substring of a corpus that has `"Maria
Lopez"` — different spelling, fails, as it should.

**Why headings and `list-pure-link` items are excluded from 1b/1c:**
Headings are frequently short, title-cased, and often programmatically
constructed (date/post-type templates) rather than free LLM prose — scanning
them produces heading-specific noise (ordinary words capitalized for
styling) without meaningfully improving hallucination coverage, since any
date/name of consequence also appears in the scanned body prose.
`list-pure-link` items are excluded because, by construction
(`PURE_LINK_ITEM_RE`), their entire content is nothing but the citation link
— there is structurally no room for an unsourced claim to hide in a link
*label* like `"Full agenda packet"`. Inline link **text within prose**
(paragraph/list-fact blocks) stays scanned — a claim cannot dodge the gates
just by living inside `[...]`.

## Calibration against real Tier A posts

Per the task brief, ran `validateDraft` against every post in
`content/published/` (none existed when work started; five appeared —
generated by the Tier A template work in `p1-tiera` — before this task
finished). `src/gates/check-real-post.ts` is the reusable script: it parses
a post's frontmatter for `sources`, reconstructs `inputCorpus` from the DB
rows behind those exact `source_url`s (falling back to the `documents`
table for document-level citations like calendar entries), and reports
`validateDraft`'s verdict. Tier A posts are template-rendered verbatim from
source data — they never touch Gate 1 in the real pipeline (PLAN.md: "Tier A
auto-publishes... No generation = no hallucination") — but they're
excellent *calibration* ground truth: known-accurate content the gate should
not false-flag.

**First run: gates failed all 5 posts.** Two of the three failure
categories were real bugs in the gate implementation, not editorial issues
with the posts, and are now fixed:

1. **ISO date regex missed dates inside full timestamps.** `occurred_at` is
   stored as `2026-08-11T00:25:00.000Z`; the date regex's trailing `\b`
   doesn't fire before `T` (digit→letter isn't a `\b` transition), so
   `"2026-08-11"` in the draft was reported as absent from a corpus that, in
   fact, contained it. Fixed by switching digit-group boundaries to
   `(?<!\d)`/`(?!\d)` lookaround across all four date patterns.
2. **Name sequences fused across punctuation.** `"**Date:** August 18,
   2026"` tokenized to adjacent capitalized words `"Date"` and `"August"`
   with nothing between them but `:`, `*`, and a space — the sequence
   builder joined them into one unmatchable candidate `"Date August"`. Same
   root cause produced `"Location Central AvenueChino CA"` and
   `"RZK NADEEN A"`-style fusions in the ABC business tracker (comma- and
   dash-separated fields getting read as one name). Fixed by requiring a
   **pure-whitespace gap** between any two tokens joined into a sequence,
   plus adding `date`/`time`/`location`/`status`/`type`/`source` to the
   sentence-initial-exempt word list so the now-isolated label words
   themselves don't need corpus grounding.

**After fixing both, re-running against all 5 posts:**

| Post | Result |
|---|---|
| `2026-W33-business-tracker.md` | **pass** — all 3 gates clean |
| `2026-W33-news-digest.md` | **pass** — all 3 gates clean |
| `2026-08-18-chino-city-council-preview.md` | fail — Gate 1a only |
| `2026-08-19-chino-planning-commission-preview.md` | fail — Gate 1a only |
| `2026-08-24-chino-community-services-parks-recreation-commission-preview.md` | fail — Gate 1a only |

Numeric and proper-name gates are now clean (0 failures) across all five
real posts. The three meeting-preview posts fail **only** on citation
coverage, and it's a genuine, reportable finding rather than a gate bug:

1. **The meeting-preview template cites once per post, not once per
   fact.** It renders a bulleted block —
   `- **Date:** …` / `- **Time:** …` / `- **Location:** …` — followed by a
   *separate* paragraph with one link (`[City calendar entry](url)`)
   covering the whole block. Gate 1a enforces the spec's literal text
   ("every list item stating a fact needs its own link") and correctly
   holds this pattern. One preview additionally has an uncited informational
   line, `"_No agenda had been posted to our records as of publish time._"`
   — a statement about the state of our own records rather than a sourced
   claim, but it's still an un-linked substantive paragraph under the
   current classification.

   **This was left as-is, per instructions not to weaken gates to force a
   pass.** Two ways to close this gap exist and are a decision for whoever
   owns the templates/prompts, not something this gate should decide
   unilaterally: (a) have the Tier A template (and, more importantly, the
   Tier B generator prompt) repeat the link on every fact-bearing
   bullet — cheap, safe, and directly satisfies the rule as written; or
   (b) add a narrow, explicit exception to Gate 1a for the single-source
   case (if `allowedUrls.length === 1` and that URL appears anywhere in the
   non-footer draft, per-block citation is satisfied for the whole post,
   since there is no ambiguity about which source any claim came from).
   Recommend (a) for Tier B specifically — Gate 2's judge is the intended
   backstop for claims that don't cite anything and also carry no
   number/name for Gate 1 to catch (e.g. bare characterization); a
   single-source blanket exception would quietly remove Gate 1a's
   contribution to exactly that failure mode.

## Known blind spots

- **Numeric/date/time gates check presence, not attribution.** A real
  dollar figure or vote count copied into the *wrong* context (right number,
  wrong agenda item) passes Gate 1b, because the gate only asks "does this
  value exist somewhere in the corpus," never "was it attached to the right
  claim." Likewise a citation-correct paragraph that misattributes a
  quote or vote to the wrong person passes Gate 1a/1c if the name and link
  are each independently valid. Catching misattribution requires per-claim
  semantic comparison — that's Gate 2's job (the LLM judge), not Gate 1's.
- **Magnitude words aren't expanded.** `"$1.5 million"` is compared as the
  bare token `1.5`; if the corpus states the same amount as `1500000` rather
  than repeating `"1.5 million"`, the match fails even though the claim is
  accurate. Recommend the generator prompt reproduce dollar figures in the
  source's own form; extending the gate to multiply out `thousand`/`million`/
  `billion` is a reasonable follow-up if this recurs.
- **AM/PM disambiguation is loose by design.** Time matching compares
  clock-face digits only (`6:00`), ignoring meridiem entirely once both
  sides have *some* form of it or neither does. A corpus time with no
  meridiem grounds a draft time with a meridiem in either direction — so a
  spurious AM/PM flip on an otherwise-unmarked source time would false-pass.
  Judged low-risk: council meetings are reliably evening events and agendas
  typically state the meridiem explicitly.
- **Spelled-out numbers are entirely out of scope.** Gate 1b only parses
  digit tokens. `"three items"`, `"a dozen residents"`, etc. are invisible
  to it — including the "small counting number" case named in the task
  brief, which is handled by *not* implementing a list-count exemption
  (strict-by-default, as instructed), not by parsing the words.
- **Hyphenated US-style dates (`8-12-2026`) are not recognized as dates**
  (only ISO, slash, and the two "Month/Day named" forms are). A number in
  that shape is instead evaluated as a vote-tally candidate and explicitly
  excluded from tallying via a negative-lookaround guard so it isn't
  misread as one either — it currently falls through to generic-number
  checking on `8`, `12`, and `2026` as three separate values. Not one of the
  three formats named in the task brief, so left unimplemented; flag if a
  source starts emitting dates this way.
- **List-item continuation lines are naively joined with a single space,**
  and a "list block" requires its *first* line to carry a marker (a
  malformed list with no marker on its first line falls through to being
  read as an ordinary paragraph). Fine for the generator-shaped output seen
  so far; worth revisiting if a more exotic list layout appears.
- **Markdown links whose URL contains a literal `)`** aren't parsed
  correctly (`MD_LINK_RE` stops at the first `)`). None of the sources in
  `SOURCES.md` produce such URLs today; if one ever does, the link would be
  truncated and almost certainly fail the allowlist check — a safe failure
  mode (holds for review) rather than a silent miss.
- **What this gate is explicitly *not* trying to catch:** a claim that is
  correctly cited, numerically accurate, and names only real people/places,
  but is still editorially wrong — false characterization, wrong tone,
  contested-item framing that EDITORIAL.md prohibits, or a technically
  accurate quote taken out of context. That's squarely Gate 2 (the LLM
  judge) and Gate 3 (the sampling audit), not Gate 1.

## Tuning knobs (all named constants in `validators.ts`, exported where a

caller might reasonably want to inspect or extend them)

- `BUILTIN_ALLOWLIST` — whole-phrase name/entity exemptions. Add a new
  recurring institution here (e.g. if CVUSD's board gets referred to by a
  new short form) rather than teaching the sequence logic about it.
- `SENTENCE_INITIAL_COMMON_WORDS` — single-token exemption when sentence- or
  block-initial. This is where new template label words (`"Date:"`,
  `"Status:"`, …) get added as they show up.
- `TITLE_WORDS` — leading role/title words stripped regardless of position.
- `CONNECTORS` — lowercase particles that bridge two capitalized tokens into
  one sequence (`of`, `de`, `la`, …). Deliberately small; `"and"`/`"the"`
  are intentionally excluded (see Gate 1c section).
- Vote-tally magnitude guard (both halves ≤ 15) in `extractTallies` — raise
  if a covered body has more seats.
- `FOOTER_MARKER_RE` — the phrases that mark trailing content as the
  disclosure footer. Update if `DISCLOSURE_FOOTER` in
  `src/pipeline/posts.ts` ever changes wording.

## Files

- `src/gates/validators.ts` — main module (`GateInput`, `GateFailure`,
  `GateReport`, `validateDraft`, plus exported allowlist constants).
- `src/gates/validators.test.ts` — 34 tests, `node:test` (see below).
- `src/gates/check-real-post.ts` — calibration script used above; reusable
  for re-checking Gate 1 calibration whenever more Tier A posts (or, once
  Phase 1 generation exists, Tier B drafts) are available. Not part of the
  pipeline; a standalone diagnostic.

## Verification

```bash
npx tsc --noEmit                         # clean
node --test "src/gates/**/*.test.ts"     # 34/34 passing
node src/gates/check-real-post.ts        # calibration report above
```

Note: `node --test src/gates/` (bare directory, no glob) did not discover
the test file on this Node build (v24.18.0) — it errored trying to
`require()` the directory itself. The glob form above is what actually
works; use it (or the explicit file path) for CI.
