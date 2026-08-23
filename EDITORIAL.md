# EDITORIAL.md — editorial rules for Chino Valley Today

These rules bind every publishing path, human or automated. The pipeline
enforces what it can (tiers, gates, validators); the rest binds the human
reviewer. Changes to this file are editorial decisions — date them.

## Provenance

- Every published claim links to a primary source: agenda item permalink, PDF
  page, video timestamp, news-release permalink, alert URL. No source, no claim.
- Source links are provided everywhere but are not a safety mechanism: a wrong
  claim harms someone whether or not it cites its source. That is what the
  gates are for.
- Generated recaps are summaries of the public record, NEVER "minutes."
  Official minutes are a legal record adopted by the body. Label accordingly.

## Tiers (binding routing rules)

- **Tier A — auto-publish, zero LLM:** deterministic template rendering of
  structured data (alerts, meeting previews quoting agenda titles verbatim,
  license-event listings, headline+link digests, calendar items). Maximize
  what fits here; a template that quotes verbatim with links cannot hallucinate.
- **Tier B — auto-publish only on clean machine pass:** LLM-generated recaps
  and tracker narratives. Must pass Gate 1 (deterministic validators: citation
  coverage, numeric consistency, proper-name whitelist) AND Gate 2 (LLM judge
  from a different model family, structured verdict). Any flag → held.
- **Tier C — human always, judge cannot override:** crime items naming private
  individuals, anything involving minors, personnel or legal allegations,
  corrections, and anything the judge flags private_individual. Publish
  requires an explicit per-item acknowledgment. No exceptions — except the one
  carved out below for agency alert channels (amended 2026-08-17).
- **Audit:** weekly human review of a 10–15% ISO-week-seeded sample of
  auto-published Tier B. Two substantive misses in a rolling month → the post
  type is demoted to held-by-default until gates are tightened.

## Private persons

- Never auto-publish the name of a private individual. Elected officials,
  senior public employees acting in their official capacity, and business
  principals in the context of their license/application are public-role
  exceptions — but crime/allegation contexts are Tier C regardless of role.
- Minors: never named, never described identifiably, Tier C always — even if
  a source document names them (sheriff/coroner releases do).
- Coroner and sheriff release bodies are stored verbatim in the database
  (faithful archive); publication is where these rules bite.

## Contested school-district items

- No characterization of contested CVUSD items: votes, direct quotes (with
  timestamps), and links only. The recap may state what was decided and who
  voted how; it may not describe motives, tone, or sides beyond quoted words.

## Secondary press (decided 2026-08-17)

- The boundary for secondary press is the same as for every other source:
  robots.txt read mechanically against our own honest User-Agent, plus any
  binding platform ToS.
- A secondary-press item (The Champion, Daily Bulletin, regional TV, and all
  others) may carry a 1–2 sentence attributed summary, under these conditions:
  - Fetching is governed by mechanical robots.txt compliance and binding ToS.
    Prefer the outlet's feed where one exists; article fetches are polite
    (conditional GET, long intervals, cached, honest UA with contact email).
  - Summaries are short and in our own words — 1–2 sentences. No substantial
    excerpting or reproduction of the article. That limit is **copyright**,
    not scraping policy, and it holds regardless of what robots.txt permits.
  - Verbatim feed-provided title/description renders as Tier A. Any
    LLM-written summary is Tier B and passes the full gate path.
  - Every item names the outlet and links the article. The provenance stamp
    (violet) is reserved for primary records and never applied to a
    secondary-press link — attribution and provenance are different claims.
- We still cover the record, not the coverage: "headlines elsewhere" is a
  pointer service to readers. A fact reported by another outlet is never
  restated as our own claim.

## Sports and student-athletes (interim rule, 2026-08-17)

- Sports coverage is **team-level only**: scores, standings, records, and
  schedules from official sources (CIF-SS, school athletics sites). No
  student-athlete is named or identifiably described, including from official
  releases — the minors rule takes precedence until an explicit carve-out is
  decided (open decision recorded in PRODUCT.md).

## Student press and broadcast feeds (decided 2026-08-19)

**Operator decision.** Student newspapers join secondary press: residents are
interested in this coverage, and carrying it gives young journalists exposure.
High school and college papers qualify; middle school and below stay out of
scope entirely. Ingested under the same headlines-elsewhere rules as every
other outlet — verbatim title, link, and a sentence-bounded teaser; all policy
filters apply per item.

- **The minors guard does not include "high school"** (operator directive, same
  day). A school's name or context is not identification of a minor, and with
  student press ingested every item would have tripped it. What still binds,
  unchanged: juvenile/teen/child/boy/girl vocabulary, ages under 18, and the
  unvetted-private-person guard — including on the Nixle release path, which
  shares the same guard. "Middle school" and "elementary" stay in the vocabulary.
- **Locality.** The high school papers (Quest News/Don Lugo, Bulldog
  Times/Ayala) are inherently local — their masthead is a Chino Valley school,
  so items carry `meta.city` at ingest. The Breeze (Chaffey College,
  Rancho Cucamonga-based) is not: only items that textually anchor to Chino or
  Chino Hills surface.
- **Weekly-drop cap.** Student papers publish in batches; each is capped at 2
  headlines per brief so a publication day cannot crowd out professional outlets.
- **Broadcast feeds.** NBC4 Los Angeles is ingested from its robots-allowed RSS
  URL, filtered at ingest to items mentioning Chino or Chino Hills.
  NBCUniversal's ToS (reviewed 2026-08-19) restricts neither automated feed
  access nor headline link-back. Expect low volume: NBC4's Chino coverage skews
  crime and accidents, which the policy filter excludes by design.
- **KTLA is rejected on ToS, not robots.** Its main feed is mechanically
  fetchable, but Nexstar's Terms of Use prohibit any "data gathering or data
  extraction practices for any purpose" — same class as the Nixle scraping
  prohibition. Do not revisit without a change in their terms.

## Agency alert channels (decided 2026-08-17, amended 2026-08-18)

**Operator decision.** Press releases received through a subscribed agency
notification channel (today: the Sheriff's Nixle channels) auto-publish without
the per-item acknowledgment Tier C otherwise requires. **What publishes is the
agency's own headline and a link to its page. The release body is never
rendered** — the same shape the daily brief uses for fire and safety.

Two reasons the body never renders, both found in the first real Chino Hills
release and both still live hazards:

- Bodies carry `SUSPECT1: <name>, Age <n>, <city> Resident` lines, plus victims
  and witnesses. A headline names nobody, and a reader who wants the detail
  follows the department's own link. We point at the record instead of
  rehosting it.
- Every message ends with a per-recipient account link containing the
  subscription id, our mailbox address and an auth token
  (`/settings/subscription/<id>/<email>/<token>/`). Rendering bodies verbatim
  would publish a live credential.

- **What this overrides:** the Tier C "human always … no exceptions" clause,
  for this source class only. Tier C is unchanged for every other source, and
  items are still stored with `meta.tier = "C"` — the carve-out is about
  publication, not classification.
- **What still binds, enforced deterministically before publication:**
  - **Minors.** Any release whose text indicates a minor is involved is HELD,
    never auto-published. The minors rule under "Private persons" is a separate
    and stronger prohibition; it holds even when the source document names them.
  - **Geography.** Only releases flagged `chinoRelevant` publish. A Nixle
    subscription delivers every agency channel covering the area, so
    county-wide releases about other cities are archived, not published.
  - **Headline and link only.** No LLM touches these; the agency's own title
    renders verbatim above a link to its page, so these render Tier A.
    Residual risk recorded honestly: an agency headline *could* name someone,
    since nothing but convention stops it. Bodies are where names actually
    live, and those no longer reach the site at all.
- **Risk accepted by the operator:** these releases name arrested and suspected
  individuals, some of whom will never be charged or convicted, and those names
  publish without human review. The corrections policy below applies, and a
  correction here counts as an audit miss like any other.

## Source channels (decision 2026-08-12)

- Agency-operated notification channels (e.g. the Sheriff's Nixle channel)
  are primary sources. Ingestion must respect the platform's terms: Nixle is
  ingested via email subscription (its intended delivery), never page
  scraping. Cited URL = the nixle.us permalink in the message.
- User-generated platforms (Facebook, Nextdoor) remain excluded as sources.

## Corrections

- Corrections are visible: strikethrough + dated correction note on the post.
  Never silent edits. Substantive corrections get a note in the next digest.
- The corrections address is `corrections@chinovalley.today` (decided
  2026-08-17, routed to the operator by Cloudflare Email Routing).
- Every post footer: "Generated from public records with automated review;
  see sources linked above. Corrections: see About page." The footer points at
  the About page rather than carrying the address inline, deliberately: the
  address can then change without editing a single published post, which this
  document forbids doing silently. The About page is where the address is
  published.
- A correction to a Tier B post counts as an audit miss for gate-tightening.
