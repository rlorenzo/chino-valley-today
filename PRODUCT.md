# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro, confirmed 2026-08-16 (already committed in PLAN.md Phase 2). Content
collections with typed frontmatter mirroring the pipeline's post frontmatter, so
the build fails on a malformed post — a free last-line validator after Gate 1 and
Gate 2. Zero client JS shipped by default; plain scoped `<script>` for simple
behaviors; a Solid island only when a widget has real client-side state, loaded
`client:visible`. One runtime maximum.

The publishing pipeline that feeds the site is an existing Node 24 / TypeScript
codebase (SQLite, no ORM, `node --test`), deliberately dependency-lean.

## Users

Two audiences, served by one artifact:

- **Residents of Chino and Chino Hills** who care what the City Council, Planning
  Commission, or CVUSD Board of Education decided but cannot sit through a
  three-hour weeknight meeting. They arrive wanting to know what happened and
  what it means for them, in a few minutes.
- **Civic insiders** — officials, staff, commissioners, journalists, activists —
  who use it as a faster, citable record of what the bodies actually did.
- **The morning-habit reader** (the target added by the 2026-08-17
  redirection): a resident who checks every day the way they check a weather
  app — today's brief first, the archive only when something touches them.

Written for residents first, but accurate and cited enough that insiders rely on
it. Any surface must serve a casual skim and a deep citation-check equally well;
optimizing for one at the other's expense is a failure.

Arrival is issue-driven (a development near someone's house, a school board
vote, a liquor license on their block), incident-driven ("what was that fire
yesterday?"), or habitual (the morning check) — rarely feed-browsing.

## Product Purpose

A daily local brief for Chino and Chino Hills, California, answering one
question each morning: **what do I need to know today?** It ingests primary
public records and official feeds, synthesizes them with mandatory source
citations, routes everything through tiered automated gates plus human review,
and publishes a static site.

Success is that a resident checks it each morning and in two minutes knows the
weather, what happened overnight (a fire a few blocks away, a decision, a
closure), what's happening today, and what their local government did — and can
verify every one of the site's own claims against the record.

**Cadence, redirected 2026-08-17:** a daily brief assembled every morning,
mostly by Tier A templates so daily publishing does not require daily human
writing; a thin day still ships honestly (weather + today's schedule).
Meeting-driven Tier B deep posts (recaps, previews, tracker narratives)
continue at their 8–12/month rhythm and fold into the brief when they publish.
Modeled on tucsondailybrief.com; the original meeting-cadence-only scoping is
superseded.

## Positioning

The mechanism a neighboring publication could not truthfully copy is the
**verifiable-by-construction pipeline**: every published claim is traceable to a
primary source, and the system is built so unverifiable claims are structurally
blocked rather than editorially discouraged.

- `item` rows without a `source_url` are a database constraint violation.
- Tier A output is deterministic template rendering of structured data with zero
  LLM involvement — a template quoting verbatim with links cannot hallucinate.
- Tier B output must clear Gate 1 (deterministic validators: citation coverage,
  numeric consistency, proper-name whitelist) *and* Gate 2 (a judge from a
  different model family, structured verdict). Any flag holds the post.
- Held posts are reviewed by a human before publication; the archive keeps the
  raw bytes of every source document.

This is a record-of-the-record first, not commentary. Its own claims cover what
public bodies did. The daily brief additionally *points* at what other outlets
reported — a "headlines elsewhere" section, attributed, built from feed
metadata only (EDITORIAL.md amendment 2026-08-17) — but never restates another
outlet's reporting as its own claim.

## Operating Context

- **Sources (12 ingesting):** Chino Legistar, Chino Agenda Center, Chino and
  Chino Hills CivicPlus news/calendar RSS, Chino Hills AgendaQuick, Chino Hills
  Swagit video, CVUSD board listings, YouTube auto-captions for two channels,
  NWS alerts, California ABC license reports, San Bernardino County Sheriff
  news, and the Sheriff's Nixle channel via email subscription.
- **Sources (7 more ingesting since 2026-08-17, Phase 4 Task 4.1):** NWS
  daily forecast (both cities' gridpoints), San Bernardino County Fire news
  RSS, Chino Valley Fire District feeds (news, alerts, calendar), and four
  Tribe Events calendars — county library (three Chino Valley branches),
  Prado Regional Park, Chino Basin Water Conservation District, and Yanks
  Air Museum. SOURCES.md is the authoritative registry; counts here are a
  snapshot.
- **Sources (still planned, Phase 4 — direction, not capability):** CAL FIRE
  incident data (endpoint unverified), secondary-press RSS for headline
  aggregation (The Champion, Daily Bulletin, regional TV), CIF-SS / school
  athletics results (team-level only), the JS-rendered calendars (CVUSD
  district, Chaffey College, Shoppes at Chino Hills), and Ticketmaster
  Discovery for ticketed regional events.
- **Post types:** meeting previews, meeting recaps, business-tracker listings and
  narratives, news digests, alerts, and (Phase 4) the **daily brief** — a
  morning assembly of weather, overnight incidents, today's schedule, fresh
  record items, and headlines elsewhere. Sections are conditional; empty ones
  drop out rather than padding.
- **Review workflow:** generated posts land in `content/queue`, `content/held`,
  `content/rejected`, or `content/published` as markdown with YAML frontmatter,
  with state mirrored in a `posts` table. A local admin dashboard bound to
  127.0.0.1 is where a human approves, rejects, and runs the weekly audit.
- **Audit ritual:** weekly human review of a 10–15% ISO-week-seeded sample of
  auto-published Tier B. Two substantive misses in a rolling month demotes that
  post type to held-by-default until the gates are tightened.
- **Corrections ritual:** corrections are visible — strikethrough plus a dated
  correction note on the post, never a silent edit. A correction to a Tier B post
  counts as an audit miss.

## Capabilities and Constraints

**Binding editorial rules** (EDITORIAL.md; these bind every publishing path,
human or automated, and changes to them are dated editorial decisions):

- Every published claim links to a primary source. No source, no claim.
- Generated recaps are summaries of the public record and must **never** be
  labeled "minutes" — official minutes are a legal record adopted by the body.
- **Tier C is human-always and the judge cannot override it:** crime items naming
  private individuals, anything involving minors, personnel or legal allegations,
  corrections, and anything the judge flags `private_individual`. Publication
  requires an explicit per-item acknowledgment.
- Never auto-publish a private individual's name. Elected officials, senior
  public employees acting officially, and business principals in the context of
  their own license or application are public-role exceptions — but any
  crime/allegation context is Tier C regardless of role.
- **Minors are never named and never identifiably described**, Tier C always,
  even when a source document names them (sheriff and coroner releases do).
- Contested CVUSD items get votes, direct quotes with timestamps, and links only
  — no characterization of motive, tone, or sides beyond quoted words.
- Secondary press (The Champion and all others): headline + link, optionally a
  1–2 sentence attributed summary in our own words (amended 2026-08-17).
  Fetching is bounded by mechanical robots.txt compliance and binding ToS —
  not a blanket no-scrape rule. No substantial excerpting (a copyright limit,
  independent of robots); another outlet's fact is never restated as our claim.
- Agency-operated notification channels are primary sources, ingested by their
  intended delivery mechanism (Nixle by email subscription, never page scraping).
  User-generated platforms (Facebook, Nextdoor) are excluded as sources.
- Every post carries the footer: "Generated from public records with automated
  review; see sources linked above. Corrections: …".

**Terminology** (use these words, they are load-bearing): Tier A / B / C; Gate 1
(deterministic validators) and Gate 2 (cross-family judge); *recap* not
*minutes*; *preview*, *digest*, *tracker narrative*, *daily brief*; *headlines
elsewhere* for the attributed secondary-press section; post states queued,
held, published, rejected.

**Explicitly undecided — do not invent:**

- ~~**Corrections contact.**~~ **Decided 2026-08-17:**
  `corrections@chinovalley.today`, routed to the operator by Cloudflare Email
  Routing. Published on the About page; the post footer keeps pointing there
  rather than carrying the address, so the address can change without editing a
  published post.
- ~~**About page copy.**~~ **Written 2026-08-17** (`site/src/pages/about.astro`):
  what the site is, how the tiers and gates work, how corrections are handled,
  and where the material comes from. Carries live counts, no claims about
  readership.
- **CVUSD agenda-item depth.** CVUSD agenda PDFs are served from
  `files.smartsites.parentsquare.com`, whose robots.txt is a blanket
  `Disallow: /`. The scraper honors it, so CVUSD coverage is listing-level only
  (meetings and links, no agenda items). Three options remain open: a
  narrowly-scoped robots exception, permanent listing-level coverage, or asking
  the district for an allowlist or direct feed. This is a policy decision.
- **Student-athlete naming in sports coverage.** The minors rule ("never
  named") collides with routine sports reporting. Interim rule (EDITORIAL.md
  2026-08-17): team-level coverage only — scores, standings, schedules, no
  names. Open options: keep team-level permanently; allow names for
  achievements drawn from official releases; case-by-case Tier C review. This
  is a policy decision for the operator, not a builder default.

## Brand Commitments

- **Name:** Chino Valley Today.
- **Domain:** `chinovalley.today`, confirmed 2026-08-16. PLAN.md names
  `cvtoday.rexlorenzo.com` as an interim host on an existing Caddy droplet; the
  site origin should be a single config value so moving between them is one line.
- **Voice, as established by the editorial rules rather than a style guide:**
  factual, extractive, and uncharacterized. State what the record says and stop.
  No motive, tone, or adjectives of judgment. A status change is reported as the
  record states it, with no speculation about why.
- Record codes quoted from source documents (ABC license types, status codes) are
  passed through verbatim and explained in a deterministic glossary appended
  outside the gated body — never paraphrased or interpreted by a model.

## Evidence on Hand

**Real:**

- 9 published posts in `content/published/` — 3 meeting recaps (Chino City
  Council, Chino Hills City Council, CVUSD Board), 3 meeting previews, a
  business-tracker listing, a business-tracker narrative, and a news digest —
  each human-reviewed and approved.
- A populated archive: 2,381 items across 53 documents in `data/cvtoday.db`,
  plus content-addressed raw source bytes in `data/raw/`.
- Per-source dossiers in `reports/notes/` (12 files) documenting method, HTTP
  behavior, extraction quality, and open questions for each source.
- `reports/poc.html`, a generated Phase 0 report.
- 149 passing tests, including gate validators and the ISO-week bundler.
- **The site is live at `https://chinovalley.today` as of 2026-08-17** —
  deployed to the droplet behind Cloudflare, scheduled scrapes and offsite
  backups running, deploy-on-push CI verified. The database on the host has
  grown past the local snapshot as timers run.

**Absent — future work must not fabricate these:**

- No known readers, subscribers, traffic, or engagement of any kind. The site
  launched 2026-08-17 with **no promotion**; no metrics, no vanity counts, no
  "trusted by" claims, no social proof.
- No testimonials, quotes, endorsements, press mentions, or partner logos.
- No masthead or named staff beyond the operator.
- No pricing, subscription, licensing, or funding model has been decided.
- **No daily brief has ever been assembled**, and none of the new Phase 4
  item types (forecast periods, fire news, events) renders on the public
  site yet — the Task 4.1 sources ingest into the database only. Secondary
  press, sports, CAL FIRE incidents, and the JS-rendered calendars are not
  ingesting at all. The pipeline is ahead of the product surface.

## Product Principles

1. **Verifiability over polish.** Every claim traces to a primary source, and the
   trace must be usable by a reader who wants to check it — not merely present.
2. **Fail closed.** When a check is uncertain, hold the post. A missed
   publication costs a week; a wrong one naming a resident costs trust that does
   not come back.
3. **Report the record, not the story.** State what a public body did. No motive,
   tone, sides, or characterization beyond quoted words.
4. **Protect the non-public person.** Private individuals and minors are treated
   as protected by default, at every layer, regardless of what a source document
   discloses.
5. **Serve the skim and the audit with one artifact.** A resident scanning for
   two minutes and an insider verifying a citation must both be well served by
   the same page.

## Accessibility & Inclusion

No product-specific standard has been established yet — recorded as an open
decision rather than assumed. Worth deciding deliberately given the audience:
this is civic information for a general public that includes older residents and
people reading on phones, and the primary artifact is text.
