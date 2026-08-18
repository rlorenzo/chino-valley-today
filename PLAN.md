# PLAN.md - Chino Valley Today

Branding: "Chino Valley Today" (chinovalley.today, registered and live
2026-08-17). A daily local news brief for Chino and Chino Hills, CA: automated
ingestion of primary sources and official feeds, LLM synthesis with mandatory
source citations, tiered machine + human review gates, static site output.
Modeled on tucsondailybrief.com. [REDIRECTED 2026-08-17: originally scoped to
meeting-cadence publishing only (8-12 posts/month); now a daily brief assembled
every morning from Tier A templates, with meeting-driven Tier B posts folded
in — see Phase 4.]

This plan covers Phase 0 (scraper POC) in detail and later phases in outline.
Do not build ahead of the current phase.

---

## Status (updated 2026-08-17)

**Phase 2: COMPLETE — the site is LIVE at <https://chinovalley.today>**
(2026-08-17): Astro site deployed to the shared droplet behind Cloudflare,
systemd scrape/backup timers enabled, nightly offsite backup to B2,
deploy-on-push CI verified. (Infrastructure identifiers live in the private
Obsidian note, deliberately not in this public repo.)

**2026-08-17: DAILY-BRIEF REDIRECTION** (branch `daily-brief-redirect`). The
record-led site is useful but not engaging: it answers "what did the council
do" and never "what do I need to know today." Redirection decisions (all
confirmed with the operator, documented in PRODUCT.md / EDITORIAL.md /
DESIGN.md / surface brief v2):

1. **Daily brief, auto-assembled**: a new `daily-brief` post type built every
   morning by Tier A templates from the last 24h of items + today's schedule;
   Tier B narratives fold in when published. Daily cadence without daily human
   writing; thin days ship honestly (weather + schedule).
2. **Four new content areas**: fire/EMS incidents, daily weather forecast,
   secondary-press headline aggregation, team-level sports + community events.
   See Phase 4.
3. **Editorial amendment (dated in EDITORIAL.md)**: secondary press may carry
   a 1-2 sentence attributed summary. The old blanket never-scrape stance was
   not the operator's rule — the boundary is mechanical robots.txt compliance
   plus binding ToS, with no substantial excerpting (a copyright limit).
   Interim sports rule:
   team-level only, no student-athlete names (minors rule precedence; open
   decision recorded in PRODUCT.md).
4. **Visual world retained**: Dairy Inspection Mark stays; the front page
   re-composes to lead with Today (surface brief v2 has the full critique of
   the v1 index and the new structure).

Phase 4 (below) supersedes Phase 3's ordering: the daily brief is the next
build target; podcast/newsletter/growth follow it (the newsletter is strictly
better fed by a daily brief anyway).

**Phase 0: COMPLETE** (commit effdfed). 12 sources ingesting (11 planned + City
of Chino YouTube captions added after launch), all acceptance criteria
verified, all 7 open questions answered — see SOURCES.md and reports/notes/.
`npm run poc` regenerates reports/poc.html.

**2026-08-13 — environment rebuilt after a macOS reinstall.** Git survived;
gitignored state (data/, .env, content/held/) did not. Full re-scrape rebuilt
the DB + raw archive: 12/12 sources, 2,358 items (≥ pre-wipe baseline); new DO
Inference key created; yt-dlp reinstalled. The old "2 stale duplicate item
rows" open decision dissolved with the rebuild (verified clean). Lesson
banked: the raw archive has no backup until Phase 2 — interim backup job is a
recommended next step.

**Phase 1: functionally COMPLETE.**

- Infrastructure (commits 2598a8d..6bf3f1d): EDITORIAL.md; post lifecycle +
  posts/audit_log; Tier A generators (5 real posts); Gate 1 validators;
  Gate 2 cross-family judge (qwen3.5, glm-5.2 backup) with Tier C routing;
  recap pipeline with keep-best repair; admin dashboard; LLM client.
- **First full Tier B lifecycle completed 2026-08-13**: all three bundle
  recaps (Chino 7/21, Chino Hills 7/14 — agenda recovered via the new
  `npm run one chinohills-agendas -- YYYY-MM-DD` backfill mode — and CVUSD
  7/16) generated, held at Gate 1 on legitimate failures, human-reviewed in
  the dashboard, and PUBLISHED (posts.status=published, published_via=manual).
  Every hold was the designed protection working: verbatim-title drift,
  malformed citation URLs, ASR-garbled names ("Appointment of Elise J").
- **Gate 1c hardened via adversarial review** (commits 4a05921, 3d3abbb,
  25b9737, 50649bf): fixed real link-label/prose fusion false positives
  without loosening — three Codex review rounds each found a genuine bypass
  in the previous fix (mid-sentence splits, comma continuations, decoy
  chained links); all closed with mutation-verified regression tests
  (44 tests). Documented accepted residual: sentence-final citation-label
  names, covered by the Gate 2 judge.
- **Nixle email ingester LIVE** (sbsheriff-nixle-mail, commits c61185e,
  639c7d6) — completes amended Task 0.9. Mailbox
  a controlled mailbox subscribed (address in .env, not tracked); IMAP
  read-only polling;
  ingests only nixle.us-permalink-carrying messages (provenance rule),
  everything Tier C. First live poll verified; first real alert (~1-2 wk
  cadence) will validate email-template assumptions.
- **DO prompt caching: closed as not-caller-fixable.** Docs say automatic for
  deepseek-4-flash; our prompts are verified deterministic; feature is
  "opportunistic" Public Preview with undocumented replica affinity. Support
  ticket drafted. Budget as if caching never engages (~2-3¢/recap).
- **Business-tracker narrative (Tier B) built 2026-08-14** (`npm run tracker`,
  src/pipeline/business-tracker.ts): weekly synthesis of ABC license events +
  business-relevant Legistar planning items per ISO week (UTC), same gate path
  as recaps. License-event facts are rendered once into a synthesized item
  body so generator, judge, and gate corpus all see identical text (an
  adversarial-verifier finding: raw meta keys leaked into the prompt but not
  the corpus, and the judge never saw meta at all). First live run (2026-W33)
  HELD at Gate 1 on one proper-name fusion ("Two ABC" — generator lede
  counting) — designed behavior, awaiting dashboard review.
- **DO API change caught 2026-08-14**: Gradient now rejects max_tokens
  combined with response_format json_object (HTTP 400, both judge models) —
  would have broken every Gate 2 call. llm client omits max_tokens in JSON
  mode per the platform's error guidance.
- TODO (Phase 1 remainder): first weekly audit pass through the dashboard;
  possible prompt tweaks only if failure classes recur (verbatim titles incl.
  articles; no invented Title-Case section labels on transcript-only bundles;
  narrative ledes that count events).
- OPEN DECISIONS: CVUSD agenda-PDF robots exception (scoped skipRobots vs
  listing-only); item idempotency across packet re-uploads (external_id is
  document-scoped; see vault task).

**Phase 3: not started** (podcast + growth; re-sequenced after Phase 4 — see
the 2026-08-17 status entry above). Phase 2 completed 2026-08-17 with the
proper nightly offsite backup to B2 in place.
Interim backup landed 2026-08-14: `npm run backup` (scripts/interim-backup.sh)
snapshots the DB (WAL-safe .backup + integrity check), data/raw, .env, and
content/ working state to `~/Backups/chino-valley-today/<date>/` (override with
CVT_BACKUP_DIR; point it at a cloud-synced folder for offsite). Run it after
scrape/review sessions. Phase 2 still owes the proper nightly offsite job.

---

## Guiding constraints

1. **Provenance is non-negotiable.** Every published claim links to a primary source
   (agenda item URL, PDF page, video timestamp, news release permalink). The DB schema
   enforces this: an `item` without `source_url` is a constraint violation. The
   synthesis step must emit citations; a post-generation validator rejects output
   containing uncited claims.
2. **Static output.** The public site is plain HTML/CSS generated at publish time.
   No server-side runtime for visitors. Target: runs on the cheapest DigitalOcean
   droplet ($4/mo regular, 512MB) or colocated on an existing droplet behind Caddy.
3. **Local-first data.** SQLite via better-sqlite3. Raw fetched artifacts (PDFs, HTML,
   JSON, VTT captions) stored on disk under `data/raw/`, content-addressed by SHA-256.
   Nothing external except source fetches and LLM inference calls (DO Gradient).
4. **Risk-tiered publishing gate.** Not everything needs human eyes; the riskiest
   things always get them. Content routes by tier (full spec in Phase 1):
   - Tier A auto-publishes: deterministic template rendering of structured data
     (alerts, agenda listings, license events). No generation = no hallucination.
   - Tier B auto-publishes after machine gates: deterministic validators
     (citations, numeric consistency, proper-name whitelist against inputs) plus
     an LLM judge on a different model family. Any flag = held for human review.
   - Tier C always requires a human: crime naming private individuals, minors,
     personnel/legal allegations, corrections. No exceptions, no judge override.
   - Weekly sampling audit of 10-15% of auto-published Tier B output.
   Source links are provided everywhere but are not a safety mechanism: a wrong
   claim harms someone whether or not it cites its source.
5. **Polite scraping.** Respect robots.txt. Conditional GET (ETag/Last-Modified) where
   supported. Cache everything; never re-fetch unchanged documents. Identify with a
   custom User-Agent including a contact email. Government meeting data is public
   record; be a good citizen anyway. [AMENDED 2026-08-17: secondary press
   (including championnewspapers.com) is fetchable under the same rules —
   robots.txt read mechanically against our UA, plus binding ToS — with
   published output limited to short attributed summaries; see EDITORIAL.md.]

## Stack

- Runtime: Node 24 LTS (managed via nvm), TypeScript, ESM
- DB: SQLite via node:sqlite (stable built-in since Node 24; synchronous, zero
  deps). Fall back to better-sqlite3 only if a needed feature is missing.
  Single file at `data/cvtoday.db`, WAL mode
- Scrape/parse: undici (fetch), cheerio (HTML), pdf-parse or pdfjs-dist (agenda PDFs),
  fast-xml-parser (RSS), yt-dlp invoked via child_process (YouTube captions)
- LLM inference: DigitalOcean Gradient serverless inference (OpenAI-compatible
  endpoint) for both synthesis and judging, later phase; POC stores raw data only.
  Single llm-client module with per-task {model, endpoint} config so any task can
  be repointed (including to Anthropic) without code changes
- Static site: Astro (Phase 2). Content-first SSG: content collections with typed
  frontmatter, zero client JS by default, official RSS/sitemap integrations,
  Pagefind-friendly for later search. Island policy: vanilla `<script>` modules by
  default; Solid (@astrojs/solid-js) only if a widget ever earns a framework.
  Not a POC concern.
- Scheduling: systemd timers on the droplet (better logging/failure visibility than cron)
- Deploy: rsync build output to Caddy-served directory; Caddy config is one site block

## Repo layout

```text
chinovalley-today/
  PLAN.md
  SOURCES.md              # living registry of sources, endpoints, quirks
  package.json
  src/
    db/schema.sql
    db/index.ts           # connection, migrations, insert helpers
    fetch.ts              # polite fetcher: UA, conditional GET, rate limit, raw archive
    scrapers/
      chino-legistar.ts
      chino-agendacenter.ts
      chino-news-rss.ts
      chinohills-agendas.ts
      chinohills-news-rss.ts
      chinohills-swagit.ts
      cvusd-board.ts
      youtube-captions.ts
      nws-alerts.ts
      abc-licenses.ts
    poc-report.ts         # renders POC findings to reports/poc.html
  data/
    cvtoday.db
    raw/<sha256-prefix>/<sha256>.<ext>
  reports/
```

## Database schema (POC scope)

```sql
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,          -- 'chino-legistar', 'cvusd-board', ...
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  method TEXT NOT NULL,              -- 'api' | 'rss' | 'html' | 'pdf' | 'captions'
  active INTEGER DEFAULT 1
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT NOT NULL,                 -- canonical public URL (the link-back target)
  doc_type TEXT NOT NULL,            -- 'agenda','minutes','packet','video','captions',
                                     -- 'news_release','alert','license_report'
  title TEXT,
  meeting_date TEXT,                 -- ISO date if applicable
  fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,        -- sha256 of raw bytes
  raw_path TEXT NOT NULL,            -- data/raw/... location
  etag TEXT, last_modified TEXT,
  UNIQUE(url, content_hash)
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  source_url TEXT NOT NULL CHECK (length(source_url) > 0),  -- provenance, enforced
  item_type TEXT NOT NULL,           -- 'agenda_item','vote','news_release','alert',
                                     -- 'license_event','transcript_segment'
  external_id TEXT,                  -- Legistar EventItemId, ABC license number, etc.
  title TEXT,
  body TEXT,                         -- extracted text
  meta JSON,                         -- votes, timestamps, addresses, license type...
  occurred_at TEXT,
  UNIQUE(document_id, external_id, item_type)
);
```

Notes:

- `items.source_url` is the deepest stable link available: Legistar item permalink,
  news release permalink, YouTube URL with `t=` offset for transcript segments,
  ABC license detail URL, PDF URL (with `#page=N` fragment where viewers honor it).
- `documents.url` answers "where did this file come from"; `items.source_url` answers
  "where should the reader click." They often differ.

---

## Phase 0: Scraper POC

Goal: for each source, fetch real current data, extract structured items with
source URLs, store in SQLite, and render a single `reports/poc.html` showing per
source: fetch method that worked, sample items (5-10), the link-back URL for each,
data quality notes, and failure modes. No synthesis, no site, no styling effort.
Task 0.0 (prior-art research) precedes all scraper code.

Run everything locally first; droplet deployment is Phase 2.

### Task 0.0 - Prior-art research pass (half a day, before any scraper code)

The civic-tech ecosystem has already absorbed years of platform quirks. Read
first, port patterns, credit in SOURCES.md. Everything below is Python; we are
building Node/TS, so the deliverable is notes and URL/selector patterns, not
imports. Record findings in a SOURCES.md "Prior art" section: per repo, what
was learned, what was ported, license.

Reading map (repo -> which of our tasks it informs):

- biglocalnews/civic-scraper -> Tasks 0.2, 0.3, 0.4. Platform classes for
  CivicPlus, Legistar, Granicus, CivicClerk, PrimeGov. Read the civicplus
  module for Agenda Center URL patterns, asset-type taxonomy, and date handling
  before writing our CivicPlus scrapers. Also check their known-sites lists to
  confirm how Chino/Chino Hills/CVUSD are classified.
- opencivicdata/python-legistar-scraper -> Task 0.1. Reference for both the
  Legistar Web API path (pagination, $filter syntax, votes retrieval) and the
  HTML/ViewState fallback. Whichever branch our curl probe selects, read the
  corresponding module before implementing.
- CouncilDataProject/cdp-scrapers (legistar_utils) -> Task 0.1 and Phase 1.
  get_legistar_events_for_timespan returns events + minutes items + votes in
  one shape; steal that shape for our items/meta JSON. Separately evaluate
  (timeboxed, 1 evening max): does running a CDP instance replace part of our
  transcript pipeline, or is it too heavy for the cheap-VPS constraint?
  Record the verdict either way.
- City-Bureau/city-scrapers -> schema sanity check. Compare their normalized
  meeting spec against our documents/items schema before freezing it.
- CityMeetings.nyc (not OSS; talks/writeups) -> Phase 1 prompt design.
  Chapterized meeting summarization, and specifically handling misrecognized
  names in transcripts - directly relevant to Gate 1c (proper-name whitelist).

Contribution targets (for the public repo, after POC stabilizes):

- Swagit transcript extractor (Task 0.5) - no maintained OSS equivalent exists;
  ours becomes the reference implementation.
- The gating layer (validators + cross-family judge + tiered publishing) as a
  documented pattern or standalone package - the piece this ecosystem lacks.

Acceptance: SOURCES.md prior-art section exists; each Phase 0 task below lists
which prior-art findings it used (or "none applicable").

### Task 0.1 - Legistar API probe (do this first; it decides Chino architecture)

Chino runs Legistar (chino.legistar.com). Granicus exposes a public REST API for
many clients at webapi.legistar.com. Probe:

```bash
curl -s "https://webapi.legistar.com/v1/chino/events?%24top=5&%24orderby=EventDate%20desc" | head -c 2000
curl -s "https://webapi.legistar.com/v1/chino/matters?%24top=5" | head -c 2000
# If events work, grab items for one event:
curl -s "https://webapi.legistar.com/v1/chino/events/<EventId>/eventitems?AgendaNote=1&MinutesNote=1"
```

- **If JSON returns:** build `chino-legistar.ts` on the API. Events -> documents,
  EventItems -> items. Item permalink pattern:
  `https://chino.legistar.com/LegislationDetail.aspx?ID=<MatterId>&GUID=<MatterGuid>`
  and meeting detail: `MeetingDetail.aspx?ID=<EventId>&GUID=<EventGuid>`.
  Votes, if published, come from `/eventitems` + `/votes` endpoints.
- **If 404/empty:** fall back to scraping chino.legistar.com/Calendar.aspx (ASP.NET
  WebForms; expect ViewState pain) or the InSite RSS feed if present
  (`chino.legistar.com/Feed.ashx?M=Calendar` is the common pattern - try it).
  Document which path won in SOURCES.md.

### Task 0.2 - Chino Agenda Center (commissions)

Chino also has a CivicEngage Agenda Center at cityofchino.org/agendacenter covering
commissions (Planning, CSPR). CivicPlus exposes RSS per category:
`https://www.cityofchino.org/RSS.aspx` lists feeds; agenda center feeds look like
`/AgendaCenter/UpdateRSS.aspx?...`. Enumerate available feeds, ingest agenda PDF
links, download PDFs to raw store, extract text with pdf-parse. Items = agenda line
items (regex/heuristic split on numbered items is fine for POC; note quality in the
report). Determine whether Planning Commission lives here, in Legistar, or both;
record in SOURCES.md.

### Task 0.3 - Chino news releases + calendar

CivicPlus RSS: enumerate `https://www.cityofchino.org/RSS.aspx`. Expect CivicAlerts
feeds (news releases like the NR26-xxx series) and calendar feeds. One item per
release with permalink. This should be the easiest scraper; if RSS is missing,
scrape /597/News-Releases HTML.

### Task 0.4 - Chino Hills agendas + news

Same CivicPlus platform: enumerate `https://www.chinohills.org/RSS.aspx`. Agenda
center at chinohills.org/60/Agendas-Minutes (agendas + minutes PDFs; video only for
City Council). News/announcement feeds cover their newsflash items. Ingest agenda
PDFs same as 0.2.

### Task 0.5 - Chino Hills Swagit transcripts

Council videos live at chinohillsca.new.swagit.com (e.g. `/videos/<id>`). Pages embed
full machine transcripts. For POC: fetch the most recent council meeting page,
extract transcript text and any timestamp anchors, store as transcript_segment items
with source_url pointing at the Swagit video URL (append timestamp params if the
player supports them; verify - Swagit players commonly accept `?ts=SECONDS`).
Also check for a JSON/VTT endpoint behind the page before scraping HTML
(watch the network tab pattern: /views/... or /captions/...).

### Task 0.6 - CVUSD board

- Agenda/minutes index: chino.k12.ca.us "Meetings Agendas, Minutes, and Videos"
  pages (Finalsite CMS, year-partitioned pages, links to PDFs). Scrape current-year
  page, ingest PDFs.
- Video: YouTube channel UCWKinB4PTb_uskobmwBF8pw. Use yt-dlp to list recent uploads
  and pull auto-captions:
  `yt-dlp --skip-download --write-auto-sub --sub-format vtt <url>`.
  Parse VTT into transcript_segment items; source_url = `youtube.com/watch?v=ID&t=Ns`
  (floor of segment start). Note in report whether CVUSD also posts agendas via a
  service like Simbli/BoardDocs - check agenda PDF URLs' host, since a BoardDocs
  backend would give structured data.

### Task 0.7 - NWS alerts

Trivial, do it for completeness and as the "always have something" filler TDB uses:
`https://api.weather.gov/alerts/active?zone=CAZ560` (verify the correct forecast
zone for Chino Valley at api.weather.gov/points/33.99,-117.69 ->
properties.forecastZone). Items = active alerts, source_url = alert @id URL.
Requires User-Agent header.

### Task 0.8 - ABC license activity (business early-warning)

California ABC publishes license query and activity reports:

- Query system: <www.abc.ca.gov/licensing/license-lookup/>
- Reports: status changes and new applications, filterable by county; filter city
  Chino / Chino Hills client-side.
For POC: fetch one recent report for San Bernardino County, filter rows to
Chino/Chino Hills premises addresses, items = license_event with meta {license_no,
type, status, premises_address, primary_name}. source_url = per-license detail page
(single-license query URL pattern includes the license number). Note format
(HTML table vs CSV) and stability in the report.

### Task 0.9 - Chino PD / Sheriff releases

- Chino PD: releases flow through the city CivicAlerts feed (covered by 0.3) - verify
  and note the category ID. If PD has a separate Nixle/social-only channel, note it
  as a gap rather than scraping social platforms.
  [AMENDED 2026-08-12, decision]: agency-operated notification channels (Nixle)
  are recognized as PRIMARY sources - they are the department's official press
  channel, unlike user-generated platforms (Facebook/Nextdoor), which stay
  excluded. HOWEVER, Everbridge's Nixle ToS expressly prohibits scraping the
  web pages (search engines excepted), so ingestion is via SUBSCRIPTION
  (email delivery to a mailbox we control - the service's intended use), not
  page scraping. Cited source_url = the nixle.us permalink carried in the
  message. See SOURCES.md sbsheriff-news for the evidence trail.
- Chino Hills: SB County Sheriff news site (wp.sbcounty.gov/sheriff/news/ or current
  equivalent) - find station-tagged releases, check for WordPress RSS
  (`/feed/` suffix usually works). Filter to Chino Hills station.

### Task 0.10 - POC report

`npm run poc` executes all scrapers (each independently try/caught; one failure
must not kill the run), then renders `reports/poc.html`:

- Per source: method, HTTP behaviors (ETag support? robots.txt rules?), item count,
  5-10 sample items each showing title, occurred_at, and a clickable source_url,
  extraction-quality notes (esp. PDF text quality and caption accuracy on names),
  and open questions.
- Summary table: source | method | reliability guess | link-back depth
  (document-level vs item-level vs timestamp-level).

Acceptance criteria for Phase 0:

- [ ] Legistar API question answered definitively
- [ ] Every stored item has a working source_url (spot-check 3 per source by hand)
- [ ] At least one full recent Chino council meeting represented as items
- [ ] At least one CVUSD meeting with usable transcript segments
- [ ] ABC pipeline produces at least one real Chino/Chino Hills license event
- [ ] poc.html renders and honestly documents what is weak

### Explicit non-goals for Phase 0

No LLM calls. No site. No podcast. No Champion scraping. No Facebook/Nextdoor.
No scheduling. Run by hand.

---

## Phase 1 (outline): Synthesis + tiered publishing gate

- Post types: Meeting Preview (from agenda, publishes T-1 day), Meeting Recap
  (agenda items + transcript + votes, publishes next morning), Business Tracker
  (weekly, from ABC + planning items), Alert (NWS/PD, as needed).

### Tier A: template-rendered, auto-publish

Structured data through deterministic templates; zero LLM in the path.
Covers: NWS alerts, meeting previews (date/time/location + agenda item titles
verbatim from source), ABC license event listings, city release headline+link
digests, event calendar items. Design pressure: maximize what fits here.
A preview that quotes agenda item titles verbatim with links cannot hallucinate.

### Tier B: LLM-generated, machine-gated, auto-publish on clean pass

Covers: meeting recaps, business tracker narratives.

- Generation: DO Gradient serverless, DeepSeek V4 Flash (`deepseek-4-flash`,
  1M-token context, ~$0.07/$0.17 per 1M in/out, prompt caching). The 1M context
  fits a full meeting transcript + agenda packet in one call - no chunking layer.
  Low temperature, extractive prompt contract - every claim carries a trailing
  source link drawn ONLY from provided items' source_urls. Open-weight models
  drift more than frontier models on long-transcript synthesis; the gates below
  exist to absorb exactly that. If sampling audits show a post type failing
  repeatedly, first remedy is escalating that task via config (see model ladder),
  not loosening gates.
- Model ladder (all on DO Gradient, all config-driven; verify catalog at build
  time - it moves fast and Meta's Llama line on DO is stale/EOL-bound):
  a. generator: deepseek-4-flash
  b. judge: qwen3.5-397b-a17b (DO-flagged evaluations judge model, ~$0.30/$1.93;
     backup: glm-5.2, explicit structured outputs)
  c. escalation: kimi-k3 (strongest open model on platform, ~$2.85/$14.25) for
     post types that repeatedly fail gates or unusually contentious meetings;
     commercial Claude/GPT available behind the same endpoint if ever needed
  Expected cost at 12 posts/month (generate + judge): under $1/month.
- Gate 1, deterministic validators (fail = hold):
  a. every paragraph cited; every cited URL is in the input set
  b. numeric consistency: every number in output appears in input
     (vote counts, dollar amounts, dates, addresses)
  c. proper-name whitelist: every capitalized name in output appears in input
     (NER pass; catches invented or misattached people/places)
- Gate 2, LLM judge (fail or flag = hold): different model FAMILY than the
  generator, also on DO Gradient (DeepSeek generates, Qwen judges). Same vendor
  is fine; same family is not - the point is uncorrelated failure modes.
  Judge returns structured JSON. ~$0.02 per recap. Judge receives draft +
  source items, returns structured JSON: per-claim faithfulness verdict, plus
  content flags for {allegation, crime, private_individual, minor, personnel,
  characterization/opinion, legal_matter}. Any flag or faithfulness failure
  routes to held/, with judge reasons attached for fast human review.
- Gate 3, sampling audit: weekly human review of 10-15% random sample of
  auto-published Tier B posts. Log findings; two substantive misses in a month
  = tighten gates or demote the post type to held-by-default.

### Tier C: human-required, judge cannot override

Crime items naming private individuals, anything involving minors, personnel or
legal allegations, corrections, and any item the judge flags private_individual.
Expected volume: 1-2/month. These render as drafts only; publish command requires
an explicit per-item acknowledgment.

### Mechanics

- Pipeline writes to `queue/` -> validators/judge route to `publish/` or `held/`.
- Admin dashboard at `/admin`, Caddy basic auth, served by a minimal Node service
  (Hono, localhost-bound, reverse-proxied; public site remains fully static).
  Single page, three sections:
  a. **Published feed**: reverse-chron Tier A/B posts with tier badge, judge
     faithfulness score, content flags (if any passed at threshold), and per-post
     source count. Glanceable "is the pipeline behaving" view.
  b. **Held queue**: Tier C items and gate failures, each with judge JSON rendered
     as reasons, diff-friendly draft view, and approve/edit/reject actions.
     Approve on Tier C requires per-item acknowledgment checkbox.
  c. **Audit queue**: deterministic weekly sample (10-15% of auto-published
     Tier B, seeded by ISO week so the list is stable), each with pass/fail
     buttons and a notes field. Failures logged to an `audit_log` table;
     two substantive misses in a rolling month = post type demoted to
     held-by-default until gates are tightened.
- Dashboard also surfaces pipeline health: last run per scraper, fetch failures,
  documents ingested this week. (Reuses the poc-report rendering approach.)
- Write actions (approve/reject/audit) go straight to SQLite; publish action
  triggers static rebuild + rsync. Auto and manual paths share one command.
- Every post footer: "Generated from public records with automated review;
  see sources linked above. Corrections: [email]." Honesty about the pipeline
  is both ethical and differentiating.
- Editorial rules file (EDITORIAL.md): Champion and all secondary press link-only
  with at most one-line framing; corrections policy (strikethrough + note, never
  silent edits); private-person naming policy; no characterization of contested
  CVUSD items - votes, quotes, links only. Source-channel policy: agency-operated
  notification channels (e.g. Sheriff's Nixle) are primary sources ingested via
  subscription per their ToS; user-generated social platforms remain excluded.
  All sheriff/PD content is Tier C when it names private individuals.

## Phase 2 (outline): Static site + droplet

- Astro static build. Content collection schema mirrors pipeline frontmatter
  (post_type, tier, meeting_date, sources[]); build fails on malformed posts,
  which is a free last-line validator. Pages: index (reverse-chron), per-post
  permalink, per-topic tag pages (planning, cvusd, business, safety), about,
  RSS feed (@astrojs/rss). Zero client JS shipped by default.
- Interactivity policy: plain Astro `<script>` tags (scoped vanilla modules) for
  simple behaviors (subscribe form, collapsible sections, filters). A widget
  earns Solid only when it has real client-side state (derived values, shared
  state across components, frequent updates). Any Solid island loads with
  client:visible so non-interacting readers still get 0KB of JS. No other
  frameworks; one runtime maximum, ~7KB flat if it ever ships at all.
- Search later via Pagefind (framework-free, indexes the static build).
- Droplet: colocate on existing Caddy droplet as a subdomain first
  (cvtoday.rexlorenzo.com); purchase chinovalley.today (~$22/yr on Cloudflare, standard tier) when validated. Caddy block is
  file_server only. Separate 512MB droplet later only if isolation is wanted.
- systemd timers: fetch hourly for RSS/alerts, meeting-day-aware schedule for
  agenda/video sources (poll transcript availability the morning after meetings).
- Backups: nightly `sqlite3 .backup` + gzip, `rclone copy` to a per-project B2
  bucket, 14 local / 14 remote — the same mechanism as the Rush Call,
  SpotTheStar and foreshock backups, so there is one restore procedure across
  every project. `data/raw` is mirrored file-by-file rather than tarred, since
  its filenames are content hashes and only new files need uploading.
  (Supersedes the original "DO Spaces or restic" note, 2026-08-17.)
  The raw archive IS the moat; do not lose it.
- Secrets: `.env` on droplet, never in git.

## Phase 4: Daily brief + expanded sources (redirection 2026-08-17)

Sequenced BEFORE Phase 3 (the newsletter is strictly better fed by a daily
brief). Goal: every morning the site answers "what do I need to know today" —
weather, overnight incidents, today's schedule, fresh record items, headlines
elsewhere — assembled by Tier A templates so daily cadence never requires
daily human writing. Initial source recon ran 2026-08-17 (web-research pass;
findings below marked verified/unverified honestly — unverified means the
probe task must confirm before building).

### Task 4.0 - Source probes (record in SOURCES.md, Phase-0 format)

Recon verdicts to confirm or refute, per source:

- **NWS daily/hourly forecast — VERIFIED, trivial.** Chino resolves to
  gridpoint SGX/47,73: `api.weather.gov/gridpoints/SGX/47,73/forecast` and
  `/forecast/hourly`. Same API and politeness rules as the alerts scraper
  already ingesting. Probe: confirm the Chino Hills gridpoint too (valley vs
  hills may differ, same as the alert-zone question in Phase 0).
- **SB County Fire RSS — VERIFIED, easy.** `sbcfire.org/feed/` is standard
  WordPress RSS with stable item permalinks (press releases, major-incident
  news). Highest value-to-effort of the new sources; ship first.
- **Chino Valley Fire District RSS — VERIFIED plumbing, easy.** CivicPlus,
  same platform family as both cities' existing feeds: News Flash
  (`chinovalleyfire.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`), Alert
  Center (ModID=63), Agenda Center (ModID=65), Calendar (ModID=58). Feed
  validated but empty on probe day; mostly config, not new code.
- **CAL FIRE incidents API — UNVERIFIED, verify before building.**
  Third-party-documented GeoJSON endpoint
  (`fire.ca.gov/umbraco/api/IncidentApi/GeoJsonList?inactive=true`, year
  param) with per-incident permalink pages. Recon fetches got 403 on both the
  endpoint AND robots.txt (bot-detection, not a robots verdict). Probe with
  the pipeline's own honest UA; read robots.txt mechanically in that pass.
- **Champion Newspapers RSS — UNVERIFIED, careful follow-up.** TownNews CMS;
  the usual search-based RSS pattern returned 429 (rate-limited, not absent).
  Their robots.txt blocks ~30 named AI crawlers (ClaudeBot, GPTBot, ...) but
  does not disallow general paths for other agents — mechanically, our custom
  contact-email UA is permitted. Prefer the feed once found; article fetches
  are allowed under the amended editorial rule, extra-polite (long intervals,
  conditional GET). Highest editorial value in the headlines-elsewhere set.
- **SCNG papers (Daily Bulletin, SB Sun) — BLOCKED at network level** to the
  recon tool; needs a probe from the pipeline's own client, with its own
  robots.txt check, before any verdict.
- **SB County Library events — VERIFIED (2026-08-17), easy.** The sbclib.org
  hostname sits behind aggressive Cloudflare (403 even to browser probes),
  but the identical WordPress serves openly at **library.sbcounty.gov**,
  whose robots.txt disallows only `/wp-admin/`. The Events Calendar REST API
  is public JSON with item-level permalinks, times, and age-group categories:
  `library.sbcounty.gov/wp-json/tribe/events/v1/events?venue=<id>&start_date=...`
  Venue IDs: Chino Branch **1181** (61 upcoming on probe day), James S.
  Thalman Chino Hills **1250** (71), Cal Aero Preserve Academy **1241** (20).
  Kids programming (storytimes, LEGO events, craft corners) is exactly the
  daily brief's "today at the library" material. Use the county hostname
  only; never fight the sbclib.org WAF.
- **School athletics calendars — WEAK ROI, probe last.** No district-wide
  sports platform found; Chino High embeds a Google Calendar (a public iCal
  URL may exist behind the embed — get the calendar ID). Four separate
  per-school integrations otherwise. Team-level coverage only (EDITORIAL.md
  interim rule).

Community-events recon, second pass (2026-08-17):

- **Yanks Air Museum — VERIFIED, easy.** WordPress + Tribe on yanksair.org
  (robots at `www.yanksair.org`: wp-admin only, `Crawl-delay: 10` — honor it).
  Full subscribe block: iCal/webcal/.ics export. Permalinks
  `/event/<slug>/`; events listed through mid-2027.
- **Chino Basin Water Conservation District (cbwcd.org) — VERIFIED, easy.**
  WordPress + Tribe, robots fully open. ICS feed at
  `?post_type=tribe_events&ical=1&eventDisplay=list`; permalinks
  `/event/<slug>/`; category filters (e.g. free-workshops). Water
  Wednesdays, compost giveaways, garden classes — exactly the free
  community programming a daily brief wants.
- **SB County Regional Parks / Prado — VERIFIED, easy** (REST confirmed
  directly 2026-08-17): `parks.sbcounty.gov/wp-json/tribe/events/v1/events`
  with `venue=1897` for Prado Regional Park; robots wp-admin only. Same
  Tribe family as the library and sheriff sources.
- **Planes of Fame Air Museum — moderate, scrape-only.** No feed; custom
  CMS; stable permalinks `planesoffame.org/events-calendar2/<slug>`; robots
  permissive on event paths. Distinctive Chino Airport content (Hangar
  Talks, airshows); worth a small HTML scraper after the feed sources land.
- **UNVERIFIED — JS-rendered calendars, probe with a real browser client:**
  CVUSD district calendar (`chino.k12.ca.us/page/page_calendar?calID=134999`
  — main-domain robots allows it, unlike the ParentSquare file CDN; the
  widget likely calls an inspectable ParentSquare API), Chaffey College
  calendar (`chaffey.edu/calendar/` — robots permissive, vendor unknown),
  Shoppes at Chino Hills (`shoppesatchinohills.com/eventscalendar/` —
  correct domain spelling, robots open, SPA route).
- **Ticketed regional events (recon 2026-08-17, backlog):** Ticketmaster
  Discovery API is genuinely open (free key, 5,000 req/day, lat/long search,
  stable permalinks) — Tier A material for a venue-whitelisted "worth the
  drive" section (Toyota Arena, Ontario Improv, Fox Pomona, Glass House,
  Ontario Convention Center). SeatGeek API in reserve (free client ID,
  overlapping inventory, attribution required). Eventbrite stays rejected in
  every form — including email-digest ingestion, which changes the transport
  but not the ToS content-republishing prohibition.
- **Skip, with reasons:** Eventbrite (public location-search API shut off
  Feb 2020; discovery is gated to distribution partners), Chamber of
  Commerce calendar (GrowthZone at business.chinovalleychamber.com, no
  feed, ribbon-cutting/networking content; if ever revisited, check that
  subdomain's own robots.txt — only the marketing domain was checked),
  Chino Youth Museum (city facility — its events already flow through the
  ingested cityofchino.org calendar; confirm ingestion isn't filtering
  that facility out), Heritage Farmers Market (no per-event data — render
  as a static recurring line in the brief, "every Wednesday 3:30–7:30pm at
  the Shoppes", sourced to heritagefarmersmarket.org/chino-hills).

**Rejected by recon, with reasons (do not revisit without new evidence):**
Watch Duty (ToS prohibits the access needed), MaxPreps (robots.txt disallows
exactly the team/school/scores paths needed, for all agents — a mechanical
block), PulsePoint (no official API, agency participation unconfirmed),
CHP incidents page (no stable permalinks — transient ASP.NET postback rows
fail the "citable permalink" requirement). **Patch — low priority, not
rejected** (reclassified under the 2026-08-17 scrape-policy clarification:
its robots.txt blocks named AI crawlers, not our UA or general paths;
mechanically permitted, but no feed was found and local coverage is thin).

### Task 4.1 - Ingest the easy verified set — DONE 2026-08-17

Landed same day as planned: seven scrapers (216 items on first run), a shared
Tribe-events core, new tests, SOURCES.md + dossiers, and timer-group
assignments (fire/forecast → frequent, event calendars → daily). Deltas from
the original scope sketch below: `cvfd-news` ingests News Flash + Alert
Center + Calendar in one scraper (supersedes the separate `cvfd-alerts`
key); the forecast ingests the daily gridpoint endpoint only (the hourly
endpoint is deferred until a surface needs it); and all four event calendars
use the Tribe REST API rather than ICS — same data, structured categories
and per-occurrence ids included. All three CVFD feeds were empty on first
run — expected; empty Alert Center is the desired steady state.

Original scope: `sbcfire-news` (WordPress RSS), `cvfd-news` (CivicPlus RSS),
`nws-forecast` (gridpoint daily + hourly), `sbclib-events` (Tribe REST API on
library.sbcounty.gov, three venue IDs above), `yanksair-events` (ICS),
`cbwcd-events` (ICS), `sbparks-events` (Tribe REST, Prado venue 1897). The
three Tribe/ICS event sources share one ingestion shape — consider a generic
tribe-events scraper parameterized by host/venue. Each: source row, scraper,
dossier in reports/notes/, items with stable source_urls. All Tier A-able
content.

### Task 4.2 - Headlines-elsewhere ingestion

Champion first (pending 4.0 feed discovery), SCNG if unblocked. Prefer feeds;
article fetches where robots.txt permits our UA, extra-polite. Published form
is always a 1-2 sentence attributed summary + link (EDITORIAL.md amendment
2026-08-17; the no-substantial-excerpting limit is copyright and holds
regardless of robots). Verbatim feed title/description renders Tier A; any
LLM-written summary is Tier B behind the full gate path.

### Task 4.3 - Daily brief assembler — CODE COMPLETE & MERGED (PR #27, 2026-08-18)

New post type `daily-brief`, one per morning (~6am Pacific systemd timer, new
`cvt-brief.timer`): deterministic assembly of last-24h items + today's
schedule from the existing DB. Sections (all conditional, empty ones drop
out): weather line (forecast + active alerts), overnight/yesterday incidents,
today's meetings and events, fresh record items (license events, published
recaps/previews/narratives folded in by link+summary), headlines elsewhere.
Tier A frame; per-item tier routing unchanged (an incident naming a private
individual stays Tier C and simply doesn't appear until cleared). Quiet day =
weather + schedule, honestly labeled. Frontmatter extends the schema; the
Astro content collection stays the last-line validator.

**Reliability hardening landed (PR #27):**

- 15 canonical prerequisite sources contract across frequent & daily scraper groups.
- Prerequisite freshness gate (`DAILY_BRIEF_PREREQUISITE_SOURCES`, `assertPrerequisitesFresh(db, now)` / `--check-prereqs`).
- Scrape run outcome tracking schema (`scrape_runs` table & index) in `src/db/schema.sql` and lifecycle tracking in `src/run-one.ts`.
- Service dependencies (`After`/`Wants` in `deploy/systemd/cvt-brief.service`) and runner retry loop in `scripts/run-brief.sh` (6 attempts $\times$ 30s).
- Public HTTP watchdog (`src/pipeline/brief-health.ts`) verifying DB status + bounded HTTP GET to `/brief/YYYY-MM-DD/` (10s timeout), marking `/health` `pipeline=stale` on failure.
- Active in 7-day operational verification gate.

### Task 4.4 - Front page leads with Today

Rebuild index per surface brief v2 (.impeccable/surfaces/): Today → This week
→ the record (v1 treatment demoted, not degraded). Dairy Inspection Mark
retained; violet remains provenance-only; headlines-elsewhere links take a
crate-outline attribution treatment, never violet. Do not build a fake brief
before 4.3 ships real ones.

### Task 4.5 - Topic taxonomy for new content

Decide where incidents, sports/events, and headlines file (does `safety`
absorb fire/EMS? fifth topic mark?), and move topic classification from
site-side derivation (`lib/record.ts`) into the pipeline, which owns the
source keys and item types.

### Phase 4 acceptance

- [ ] Seven consecutive mornings publish a daily brief with zero human
      writing (human review only where tiers require it)
- [ ] A quiet day ships honestly (weather + schedule, no padding)
- [ ] Every brief item's link passes the existing citation spot-check ritual
- [ ] Headlines-elsewhere items render as short attributed summaries only
      (verbatim feed text as Tier A, or LLM summaries gated Tier B; never
      substantial excerpts)
- [ ] No student-athlete name anywhere (team-level rule holds)
- [ ] Index leads with Today; the record remains fully reachable and citable

## Phase 3 (outline): Podcast + growth

- TTS from published recap posts, RSS podcast feed (static XML + mp3s in Spaces).
- Email: Buttondown or Listmonk-on-droplet fed by the same content.
- Validation gate from strategy discussion: soft-launch a manual recap in the Chino
  Facebook group before Phase 2 polish; <200 subscribers after 3 months of consistent
  posting = archive the project.

## Costs

- Droplet: $0 marginal (colocate) or $4/mo dedicated
- Domain: chinovalley.today, ~$22/yr at cost on Cloudflare (Identity Digital TLD, no price cap; standard tier, not premium)
- LLM inference: DO Gradient serverless, cents per post at recap sizes for
  generation + judging combined; Anthropic API held as per-task fallback via config
- TTS (Phase 3): also on DO Gradient - ElevenLabs Multilingual v2 at $0.10 per
  1k characters (~$0.60 per recap narration) or Qwen 3 TTS at $20 per 1M chars;
  same platform, same API key

## Open questions to resolve during POC (record answers in SOURCES.md)

1. Legistar API enabled for Chino? (Task 0.1)
2. Where do Chino Planning Commission agendas actually live?
3. Does Swagit expose VTT/JSON captions and timestamp deep links?
4. Is CVUSD on BoardDocs/Simbli behind those PDF links?
5. ABC report format and whether premises city is a clean filterable field
6. Do CivicPlus RSS feeds include full text or teaser-only?
7. Correct NWS zone(s) for Chino vs Chino Hills (they may differ: valley vs hills)
