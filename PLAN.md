# PLAN.md - Chino Valley Today

Branding: "Chino Valley Today" (domain chinovalley.today identified, purchase deferred until POC validates). A meeting-driven local news brief for Chino and Chino Hills, CA. Automated ingestion
of primary sources, LLM synthesis with mandatory source citations, human review gate,
static site output. Modeled loosely on tucsondailybrief.com but scoped to
meeting-cadence publishing (8-12 posts/month), not daily.

This plan covers Phase 0 (scraper POC) in detail and later phases in outline.
Do not build ahead of the current phase.

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
   record; be a good citizen anyway. Do not scrape championnewspapers.com content -
   the Champion is link-only (see Editorial rules).

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
  Pagefind-friendly for later search. Island policy: vanilla <script> modules by
  default; Solid (@astrojs/solid-js) only if a widget ever earns a framework.
  Not a POC concern.
- Scheduling: systemd timers on the droplet (better logging/failure visibility than cron)
- Deploy: rsync build output to Caddy-served directory; Caddy config is one site block

## Repo layout

```
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

Council videos live at chinohillsca.new.swagit.com (e.g. /videos/<id>). Pages embed
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
- Query system: www.abc.ca.gov/licensing/license-lookup/
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
  CVUSD items - votes, quotes, links only.

## Phase 2 (outline): Static site + droplet

- Astro static build. Content collection schema mirrors pipeline frontmatter
  (post_type, tier, meeting_date, sources[]); build fails on malformed posts,
  which is a free last-line validator. Pages: index (reverse-chron), per-post
  permalink, per-topic tag pages (planning, cvusd, business, safety), about,
  RSS feed (@astrojs/rss). Zero client JS shipped by default.
- Interactivity policy: plain Astro <script> tags (scoped vanilla modules) for
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
- Backups: nightly `sqlite3 .backup` + tar of data/raw to DO Spaces or restic to
  existing storage. The raw archive IS the moat; do not lose it.
- Secrets: `.env` on droplet, never in git.

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
