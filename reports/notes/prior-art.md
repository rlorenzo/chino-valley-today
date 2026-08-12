# Prior-art research (Task 0.0)

Research date: 2026-08-11. All sources read via `gh api` (GitHub contents/trees API,
so exact file text) and WebFetch/WebSearch for the non-OSS entry. No code executed,
nothing installed. Repo revisions read: `civic-scraper` @ `master`,
`python-legistar-scraper` @ `master`, `cdp-scrapers` and `cdp-backend` @ `main`,
`city-scrapers` and `city-scrapers-core` @ `main` — i.e. whatever HEAD was on
2026-08-11, not a pinned tag.

---

## 1. biglocalnews/civic-scraper

Python, `civic_scraper/platforms/civic_plus/`. Not archived.

### What was learned

- The CivicPlus scraper does **not** use RSS at all. It POSTs to a server-rendered
  search endpoint and scrapes the results HTML with BeautifulSoup:
  `{base_url}/Search/?term=&CIDs=all&startDate=MM/DD/YYYY&endDate=MM/DD/YYYY&dateRange=&dateSelector=`
  (dates formatted `MM/DD/YYYY`, base_url truncated at `/Agenda` first). This single
  call returns **every committee/category** for the date range in one page, unlike
  per-category RSS feeds.
- Results HTML structure: one `<div id="catNNN">` per board/committee. Inside each,
  meeting rows live in `tbody > tr`. Each row's committee name comes from `h2`/`h3`
  text (after stripping a toggle-arrow `<span>`); meeting title is `row.p.text`.
- **Date-handling quirk, concrete and worth stealing directly**: the reliable meeting
  date is *not* in the visible cell text — it's embedded in an anchor's `name`
  attribute as `_MMDDYYYY...`, parsed with `_(\d{2})(\d{2})(\d{4}).+`. Any Cheerio port
  should read `a[name]` on the row, not visible text.
- Asset (file) links are matched as `<a>` tags whose `href` starts with
  `/AgendaCenter/ViewFile` **and that lack a `title` attribute** — CivicPlus renders
  each file link twice (once under the meeting title, once in a download menu); the
  no-`title` copy is the one to keep, and a `bookkeeping` set of already-seen hrefs
  dedupes further. Links to `PreviousVersions` are explicitly skipped.
- **Asset-type taxonomy**: `SUPPORTED_ASSET_TYPES = ["agenda", "minutes", "audio",
  "video", "agenda_packet", "captions"]` (`civic_scraper/base/constants.py`). Type is
  derived from the URL path itself — the 4th `/`-separated segment of the href, e.g.
  `/AgendaCenter/ViewFile/Agenda/...` → `agenda` — **except** a URL ending in
  `packet=true` is forced to `agenda_packet` regardless of the path segment. An
  unrecognized segment raises rather than silently guessing.
- `meeting_id` is synthesized as `civicplus_{subdomain}_{raw_id}`; useful precedent
  for content-addressing our own document IDs when CivicPlus itself gives none.
- The scraper spoofs a real desktop Chrome User-Agent string rather than identifying
  itself — this cuts directly against PLAN.md's "identify with a custom User-Agent
  including a contact email" rule. Worth testing our honest UA against
  cityofchino.org/chinohills.org early in Task 0.2/0.4; if CivicPlus's front end (WAF
  or otherwise) balks at a non-browser UA, that's a real constraint to record, not
  something to route around by spoofing.
- **Known-sites CSV** (`docs/civicplus_sites.csv`, 1,550 data rows, columns
  `end_point,begin_year,end_year,scraper_type,whitelisted,name,state,country,
  govt_level,meeting_bodies`): **neither `cityofchino.org` nor `chinohills.org`
  appears.** The only Chino-adjacent rows are `Chino Valley, AZ` (unrelated town),
  `Chino Basin Water District`, `Chino Basin Desalter Authority`, and `Chino Valley
  Fire District` — all special districts, not the cities. CVUSD does not appear
  either (expected — CVUSD is Finalsite, not CivicPlus).
  - **Why, concretely**: every `end_point` in the CSV is a `*.civicplus.com`
    subdomain (e.g. `http://ct-greenwich.civicplus.com/AgendaCenter`), and the
    generation script (`scripts/generate_civicplus_sites.py`) works from a seed list
    of such subdomains. Cities that migrated to a custom domain — which
    cityofchino.org and chinohills.org both are — fall outside that subdomain
    enumeration and simply never get discovered by this method, platform or not.
    This is a real, generalizable gap in civic-scraper's site discovery, not
    evidence about which platform Chino/Chino Hills actually run. It does **not**
    contradict PLAN.md's assumption that both run CivicPlus Agenda Center (that
    assumption rests on the URL shape `/AgendaCenter` and `/RSS.aspx` on those
    domains themselves, which this CSV has nothing to say about either way) — it
    just means there's no third-party confirmation available from this list, and
    Tasks 0.2/0.4 need to establish platform identity first-hand as already planned.

### What to port (concrete)

- The `/Search/?term=&CIDs=all&startDate=...&endDate=...` endpoint as a fallback or
  cross-check if per-category RSS (`UpdateRSS.aspx`) turns out to be teaser-only or
  missing a committee — one call gets everything.
- The `a[name]` date-extraction regex trick.
- The no-`title`-attribute link-dedup heuristic for avoiding double-counted PDFs.
- The `SUPPORTED_ASSET_TYPES` list and the "4th path segment, with a `packet=true`
  override" rule for classifying `agenda` vs `minutes` vs `agenda_packet` vs
  `captions` links.

### License

Apache License 2.0 (Big Local News, 2020). Confirmed from the `LICENSE` file text
directly (GitHub's API license detector reports "Other", but the file itself is
unambiguous Apache-2.0 boilerplate).

### Informs

Tasks 0.2, 0.3, 0.4.

---

## 2. opencivicdata/python-legistar-scraper

Python, `legistar/`. Not archived. Since Chino's Web API is confirmed live, focus was
the API path (`legistar/base.py`, `legistar/events.py`), not the ViewState HTML
fallback (`LegistarEventsScraper`/`LegistarScraper`, same file, exists and works but
is out of scope per the task brief).

### What was learned

- **Pagination convention** (`LegistarAPIScraper.pages`, `legistar/base.py`): loop
  incrementing `$skip` by 1000 each round, stop when a response page comes back with
  fewer than 1000 rows. A `seen` deque (maxlen 1000) guards against duplicate items
  if the underlying data shifts mid-scrape. This is the concrete pagination contract
  to replicate in `fetch.ts`/`chino-legistar.ts`.
- **`$filter` OData syntax**, exact working example:
  `search('/matters/', 'MatterId', "MatterIntroDate gt datetime'2017-01-01'")` builds
  a query string `?$filter=MatterIntroDate+gt+datetime'2017-01-01'`. Operators
  confirmed in use: `gt`, `ge`, `lt`. `$orderby` is used separately, e.g.
  `params = {'$orderby': 'EventLastModifiedUtc'}` for incremental/resumable scraping
  ordered oldest-to-newest specifically so a failed run can resume from "everything
  newer than the last event scraped."
- **Votes retrieval path**: events → for each event, agenda items come from
  `/events/{EventId}/eventitems`; roll calls specifically from
  `/eventitems/{EventItemId}/rollcalls` (only pulled for items where
  `EventItemRollCallFlag` is true). Agenda vs. minutes views of the *same* endpoint
  are distinguished purely by which sequence field is non-null on each item:
  `EventItemAgendaSequence` (present → item is on the agenda) vs.
  `EventItemMinutesSequence` (present → item is in the minutes); items missing both a
  title and the relevant sequence field are filtered out.
- **Known API quirk — incremental sync needs a lookback window**: when scraping
  `since_datetime`, the library explicitly subtracts a 168-hour (1 week) buffer
  before filtering, because "Minutes are often published after an event occurs –
  without a corresponding event modification" to `EventLastModifiedUtc`. It also
  OR-filters across four separate timestamp fields (`EventDate`,
  `EventLastModifiedUtc`, `EventAgendaLastPublishedUTC`,
  `EventMinutesLastPublishedUTC`) rather than trusting one "last modified" field —
  a direct, transferable answer to "how do I know when to re-poll a past meeting for
  newly-posted minutes."
- **Known quirk — deleted/expired records return HTTP 410**, not 404, with body text
  `"This record no longer exists. It might have been deleted."`
  (`LegistarSession._check_errors`); the scraper's `accept_response` override treats
  410 as acceptable-but-empty rather than an error to retry. Worth handling
  explicitly in our fetch layer's error branching.
- **Rate-limit/politeness handling**: none built in beyond what the underlying
  `scrapelib.Scraper` base class provides (its own retry/backoff config, not visible
  in this repo). No explicit sleep/throttle logic is present in the API path itself
  — politeness here is left entirely to the caller.
- Event start time is unreliable raw text: `EventTime` is manually entered by city
  clerks and "sometimes doesn't conform" to the expected `%I:%M %p` format; the
  library logs and skips (returns `None`) rather than crashing on a bad time string —
  a concrete argument for defensive time parsing rather than assuming clean data.
- `EventInSiteURL` gives the human-facing detail-page link per event — this is what
  eventually becomes the `MeetingDetail.aspx?ID=...&GUID=...` permalink referenced in
  PLAN.md Task 0.1.

### What to port (concrete)

- `$skip`-by-1000 pagination loop with a "stop when page shorter than page size"
  termination condition.
- The four-field OR-filter + 1-week lookback pattern for incremental "what changed
  since last run" polling — directly reusable for a systemd-timer-driven re-poll.
- Treat HTTP 410 with that exact body substring as "gone, not an error."
- Distinguish agenda-eligible vs. minutes-eligible items by presence of
  `EventItemAgendaSequence` vs `EventItemMinutesSequence`, not by a separate
  agenda/minutes endpoint.

### License

BSD 3-Clause "New"/"Revised" License (confirmed via repo metadata).

### Informs

Task 0.1.

---

## 3. CouncilDataProject/cdp-scrapers (`legistar_utils.py`)

Python, `cdp_scrapers/legistar_utils.py` (1,676 lines). Not archived. This is the
richest single source for Task 0.1/Phase 1 field-mapping purposes.

### The `get_legistar_events_for_timespan` shape, concretely

Signature: `get_legistar_events_for_timespan(client, begin=None, end=None) ->
List[Dict]`. It builds one nested structure per event by chaining five separate
Legistar Web API calls per event (not a single call):

1. `GET {LEGISTAR_BASE}/events?$filter=EventDate ge datetime'{begin}' and EventDate lt
   datetime'{end}'` — the event list itself.
2. For each event: `GET {LEGISTAR_BASE}/events/{EventId}/EventItems?AgendaNote=1&
   MinutesNote=1&Attachments=1` → attached under the event dict's key `"EventItems"`.
3. For each event: `GET {LEGISTAR_BASE}/bodies/{EventBodyId}` (cached across the run)
   → attached under key `"EventBodyInfo"`.
4. For each event item: `GET {LEGISTAR_BASE}/EventItems/{EventItemId}/Votes` →
   attached under `"EventItemVoteInfo"`; for each vote,
   `GET {LEGISTAR_BASE}/Persons/{VotePersonId}` (cached) attached under `"PersonInfo"`.
5. For each event item with a valid `EventItemMatterId`:
   `GET {LEGISTAR_BASE}/Matters/{MatterId}/Sponsors` → attached under
   `MatterSponsorInfo`, with each sponsor's `MatterSponsorNameId` further resolved to
   a full person record (cached) under `SponsorPersonInfo`.

So the returned shape per event is, in plain terms:
`event { ...EventFields, EventBodyInfo: {...}, EventItems: [ { ...ItemFields,
EventItemVoteInfo: [ { ...VoteFields, PersonInfo: {...} } ], MatterSponsorInfo: [
{ ...SponsorFields, SponsorPersonInfo: {...} } ] } ] }`.

This then gets normalized into CDP's `EventIngestionModel` (from `cdp_backend`, not
this repo) shaped roughly as: `EventIngestionModel { external_source_id, agenda_uri,
minutes_uri, body: Body, sessions: [Session { session_datetime, session_index,
video_uri, caption_uri }], event_minutes_items: [EventMinutesItem { index,
minutes_item: MinutesItem, matter: Matter, decision, votes: [Vote { decision,
external_source_id, person: Person }], supporting_files: [SupportingFile { ... }] }]
}`.

### Recommendation: how this maps onto our `items`/`meta` JSON

Our schema is flatter by design (one `documents` row per Legistar *Event*, one
`items` row per `EventItem`), so the CDP nesting collapses onto us like this:

- `documents` row per Event: `doc_type = 'agenda'` (or `'minutes'` once minutes are
  published — same event, re-fetched), `external`-style identity via
  `EventId`/`EventGuid` embedded in `documents.url` (the `MeetingDetail.aspx?ID=
  {EventId}&GUID={EventGuid}` permalink already specified in PLAN.md).
- `items` row per EventItem: `item_type = 'agenda_item'`, `external_id =
  EventItemId`, `title = EventItemTitle`, `source_url` = the
  `LegislationDetail.aspx?ID={MatterId}&GUID={MatterGuid}` permalink when a Matter
  exists, else fall back to the event's own permalink with an anchor/sequence
  reference. `meta` JSON should carry, verbatim from the Legistar fields: `{
  agendaSequence: EventItemAgendaSequence, minutesSequence:
  EventItemMinutesSequence, matterType: EventItemMatterType, matterStatus:
  EventItemMatterStatus, decision: EventItemPassedFlagName, sponsors: [...] }`.
- Votes as a **second** `items` row per vote (`item_type = 'vote'`,
  `external_id = VoteId`, same `document_id`, `source_url` = the parent item's
  permalink), with `meta = { decision: VoteResult, person: PersonFullName,
  personExternalId: PersonId }` — keeping votes queryable/countable independently
  (matters for Gate 1b's "every number in output appears in input" numeric check —
  vote tallies need to be individually addressable, not buried inside an agenda
  item's meta blob).
- Two **quirks worth carrying forward verbatim**, both concretely documented in this
  file's code comments:
  1. `VoteValueId` is **not** a documented enum — the code explicitly notes "The
     required integer VoteValueId = 16 seems to be 'in favor'. But don't know what
     other values would be" and instead pattern-matches the human-readable
     `VoteValueName` string with a regex for approve/oppose. Do the same — never key
     vote-decision logic off the numeric ID.
  2. The short code (e.g. "CB 11111") and the long descriptive title routinely
     arrive from Legistar in **swapped** fields relative to what you'd expect — the
     code has an explicit remapping step to fix this (`fix_event_minutes`). Worth
     testing directly against Chino's actual API responses before assuming
     `EventItemMatterFile` vs `EventItemMatterName` line up the way their names
     suggest.
  3. `EventItemMatterStatus` can be null even when votes exist; the library defaults
     to an explicit "in progress" status in that case rather than leaving it blank —
     a reasonable default to copy.

### CDP verdict (see also dedicated section below)

Timeboxed question answered: **do not run a CDP instance.** See the "CDP verdict"
section for the full rationale — short version: `cdp-scrapers`' own
`EventIngestionModel` type is imported directly from `cdp_backend`, and
`cdp_backend` bakes in Google Cloud Firestore, Google Cloud Functions, and
Pulumi-provisioned infrastructure at the persistence layer, not as an optional
swap-out. It is not compatible with the 512MB DigitalOcean/SQLite/no-cloud-services
constraint, and Node/TS was already the stated stack regardless, so installing this
Python package was never on the table anyway — only the *shape* it returns is worth
stealing, which the mapping above does.

### License

Mozilla Public License 2.0 (confirmed via repo metadata and README footer).

### Informs

Task 0.1 and Phase 1 (item/meta field mapping and vote modeling specifically).

---

## 4. City-Bureau/city-scrapers (+ city-scrapers-core)

Python/Scrapy, `city_scrapers/spiders/`. Not archived. **Note for the record**: the
actual normalized meeting schema does not live in `city-scrapers` itself — it lives
in a separate sibling package, `City-Bureau/city-scrapers-core`
(`city_scrapers_core/items.py` + `constants.py`), which `city-scrapers` depends on
for its `Meeting` scrapy Item and `CityScrapersSpider` base class. This isn't a
rename/deletion (both repos are live and actively used together), just a two-package
split worth being explicit about since the task named only the spider repo.

### The `Meeting` schema (city_scrapers_core/items.py)

Flat, one row per meeting occurrence:

```
Meeting {
  id            # slug + date + time derived, stable across re-scrapes
  title
  description
  classification  # enum: Advisory Committee | Board | City Council | Commission |
                   #       Committee | Forum | Police Beat | Not classified
  status          # enum: cancelled | tentative | confirmed | passed
  start           # ISO 8601 local datetime
  end             # ISO 8601 local datetime, nullable
  all_day         # bool
  time_notes      # free text caveat, e.g. "please confirm time on the agenda"
  location        # { name, address }
  links           # [ { href, title } ]  -- e.g. Notice/Agenda/Summary/Other
  source          # canonical URL for the meeting page itself
}
```
`required: ["id", "title", "start", "source"]` per the embedded JSON Schema.

### License

Both `city-scrapers` and `city-scrapers-core`: MIT License (confirmed via repo
metadata for both).

### Informs

Schema sanity check (below), and lightly Task 0.6 (their `CityScrapersSpider` base
class + per-agency spider file pattern is a loose structural precedent for our own
one-file-per-source scraper layout, though no CVUSD-specific code exists here since
none of their spiders target a Finalsite/BoardDocs backend).

---

## Schema sanity check

Comparing `city_scrapers_core`'s flat `Meeting` record against our
`sources`/`documents`/`items` decomposition (`src/db/schema.sql`):

**What our schema represents that theirs doesn't need to**: per-item provenance.
Their `Meeting.links` is a flat array of named links *on the meeting*; our `items`
table gives every individual agenda line, vote, and (later) transcript segment its
own `source_url`, which is the entire point of PLAN.md's "provenance is
non-negotiable" constraint. Their model has no equivalent of an addressable vote or
addressable agenda line — it's meeting-granularity, we're claim-granularity. This is
correct for a synthesis pipeline that needs to cite individual facts, and there's no
reason to flatten to match theirs.

**What theirs represents that ours currently cannot** — three concrete gaps, ranked
by how much they matter for this product:

1. **Location.** `Meeting.location = { name, address }` is a first-class field.
   Our schema has no location column anywhere — not on `documents`, not on `items`.
   This is not a cosmetic gap: PLAN.md's own Tier A design explicitly promises
   "meeting previews (date/time/location + agenda item titles verbatim from
   source)" as a zero-LLM, auto-publish, cannot-hallucinate template. As written,
   that template has nowhere structured to pull "location" from — it would have to
   be buried in an `items.meta` JSON blob on some arbitrarily-chosen item, which
   defeats the purpose of a deterministic template. **Recommend fixing before
   Phase 1**: either a `documents.location` TEXT column (simplest, since location is
   a property of the meeting/document, not of individual items) or a small
   `meta` convention documented in `SOURCES.md` if a whole column feels premature
   for POC scope.

2. **No explicit meeting/event identity spanning documents.** Their `Meeting` is one
   row that owns all of its links (agenda, minutes, notice, video) directly. Ours
   instead creates one `documents` row per artifact (an agenda PDF and its later
   minutes PDF are two separate `documents` rows), and nothing currently ties them
   together as "the same meeting occurrence" except an implicit join on
   `(source_id, meeting_date)`. Legistar's own `EventId` (see cdp-scrapers section
   above) is exactly the identity that would make this join explicit and reliable
   instead of date-based-and-hopeful — useful the moment two documents that belong
   together don't share a clean `meeting_date` (a not-implausible occurrence when a
   PDF has no reliably parseable date, e.g. CVUSD's year-partitioned Finalsite
   pages). **Recommend before Phase 1**: add a nullable `documents.event_key TEXT`
   populated with the source's native event identifier where one exists (Legistar
   `EventId`, CivicPlus `meeting_id` per civic-scraper's own synthesized ID scheme
   above) and falling back to `NULL` (today's implicit date join) where none exists.
   Low-cost, backward compatible, doesn't require a new table.

3. **No cancelled/status flag.** Their `status` enum (`cancelled | tentative |
   confirmed | passed`) captures meeting-lifecycle state directly. We have nothing
   equivalent — a cancelled meeting today would just show up as "no minutes ever
   appeared" with no positive signal that it was cancelled rather than simply not
   yet processed. Lower priority than 1–2; can live in `items.meta` on an
   agenda-level item for POC, worth a real field only if Tier A previews start
   getting cancelled meetings visibly wrong.

**Verdict: do not restructure the `documents`/`items` split — it's the right shape
for a provenance-first pipeline and is strictly more granular than city-scrapers'
flat model. Do add `documents.location` and `documents.event_key` before Phase 1
freeze**, since Phase 1's own Tier A preview design already depends on the former and
Phase 1's meeting-recap assembly (agenda + transcript + votes, per PLAN.md) will lean
on the latter the moment date-based joins get ambiguous. The cancelled/status gap can
wait.

---

## CDP verdict

**Would running a CouncilDataProject instance replace part of our transcript
pipeline, or is it too heavy for the cheap-VPS constraint? Verdict: too heavy — do
not run a CDP instance.**

Rationale, from reading `cdp-backend`'s repo structure and dependency manifest
(docs-only, nothing installed or executed):

- `cdp_backend/infrastructure/` contains `firebase.json`, `firestore.rules`,
  `storage.rules`, `lifecycle-rules.json`, and a `gcloud-functions/generate-clip/`
  Google Cloud Function — infrastructure-as-config for a specific, non-optional GCP
  deployment target (Firestore for the database layer, Cloud Storage for file
  assets, Cloud Functions for on-demand video-clip generation).
- `pyproject.toml` pins `google-cloud-firestore` as a direct dependency (version
  constrained by the `fireo` ORM it uses), meaning the persistence layer *is*
  Firestore, not a swappable backend — there's no SQLite or generic-SQL adapter to
  redirect it to.
- `cdp_scrapers` (the scraper package examined above) imports its core return type,
  `EventIngestionModel`, directly from `cdp_backend.pipeline.ingestion_models` —
  meaning even using *just* the scraper utility pulls the GCP-flavored backend
  package into the dependency graph, since the scraper's output type is defined
  there.
- This is architecturally consistent with CDP's stated purpose: it's a full
  multi-tenant hosted-instance framework (web app + Algolia-esque search + Firestore
  + video pipeline) built for cities willing to run actual cloud infrastructure, not
  a library meant to be run standalone against a local file store.
- Standing up even a minimal CDP instance would mean provisioning real GCP services
  (Firestore, Cloud Functions, Cloud Storage) and Pulumi-managing them — directly
  contrary to PLAN.md's "512MB droplet, SQLite, no cloud services" constraint — for a
  12-posts/month POC. Not worth it at this scale, and Node/TS was the stated stack
  regardless, so a Python package was never going to be installed here either way.
- Separately worth noting: even setting the GCP problem aside, CDP's video/caption
  handling (`legistar_content_parsers.py`, `Session.video_uri`/`caption_uri`) targets
  Granicus/Legistar-hosted video pages specifically. It has no Swagit support, so it
  would not have solved Task 0.5 (Chino Hills' Swagit transcripts) even if the
  infrastructure problem didn't exist — consistent with PLAN.md's own note that "no
  maintained OSS equivalent exists" for the Swagit extractor.
- What **is** worth keeping from CDP: the `legistar_utils.py` request-shape and
  quirk-handling patterns documented in section 3 above, ported by hand into
  TypeScript. Not the package, not the instance — just the shape.

---

## 5. CityMeetings.nyc (Vikram Oberoi) — not open source

No public repository; researched via the creator's own writeup and the site's public
FAQ, both fetched directly (not from memory/training data).

- Primary source: Vikram Oberoi, ["How citymeetings.nyc uses AI to make it easy to
  navigate city council
  meetings"](https://vikramoberoi.com/posts/how-citymeetings-nyc-uses-ai-to-make-it-easy-to-navigate-city-council-meetings/).
  Secondary: [citymeetings.nyc FAQ](https://citymeetings.nyc/faq/).

### Chapterization approach

A **three-step prompt-chaining pipeline**, explicitly *not* a single "find the
chapter boundaries" prompt (Oberoi reports that approach produced worse results):

1. **Extract markers**: a prompt that finds beginnings of one content type at a time
   (questions, testimony, remarks, procedural moments) rather than asking for all
   chapter starts at once.
2. **Determine boundaries**: a second, separate prompt locates where each marked
   section *ends*, working only on the transcript slice between two consecutive
   markers.
3. **Generate titles/descriptions**: type-specific prompts and formatting per
   chapter kind — e.g. QUESTION chapters get a title phrased as the question with a
   description that answers it; TESTIMONY chapters get a `"[Speaker] on [Topic]"`
   title.

Two transferable mechanical details:
- Transcripts are processed in **8,000-token chunks** specifically to avoid the
  "lost in the middle" degradation of long-context prompting — relevant context
  given PLAN.md's plan to feed a full transcript + packet into a 1M-context model in
  one call for Tier B recap generation; worth watching for the same degradation even
  with a much larger context window, and chunked marker-extraction is a fallback
  worth keeping in mind if recap quality on long meetings turns out to need it.
- Rather than asking the model for real timestamps, the pipeline invents placeholder
  **time markers** (`T459`, `T460`, ...) because "the LLM would regularly hallucinate
  timestamps that weren't in my transcript." Directly relevant to any Tier B prompt
  that needs to cite a video timestamp: don't ask the model to produce the number,
  have deterministic code substitute a known-correct value for a marker the model
  only has to *reference*.

### Proper-name handling (directly relevant to the planned proper-name whitelist gate)

Two techniques documented, at two different points in the pipeline:

1. **Transcription-layer**: the underlying transcription vendor (Deepgram, used for
   both transcription and diarization) is described as reliably mistranscribing
   certain proper names — e.g. the housing authority acronym "NYCHA" consistently
   comes out as "NITRO." The FAQ states the team has **not yet built automated
   correction for this** — it's caught mostly through user reports, described as "a
   large body of work" that's currently deprioritized for a "solo operation." This
   is a validated real-world data point that transcription-layer name errors are
   common and effortful to fully solve, which supports PLAN.md's decision to run a
   *validation gate* (reject/hold on unrecognized names) rather than attempt
   automated correction at the synthesis stage.
2. **Speaker-identification / synthesis-layer** (the more directly applicable
   technique): to identify *which council member* is speaking, and to correct
   misheard member names specifically, Oberoi supplies the LLM a known list of
   council member names and explicit instructions to infer mistranscriptions against
   that list — concrete examples given: "Jose" corrected to "Ossé," "Adrian"
   corrected to "Adrienne." This is a **known-entity-list-plus-inference** pattern,
   which is the mirror image of PLAN.md's Gate 1c (reject names *not* in the
   whitelist) rather than the same technique — Oberoi's approach actively *rewrites*
   transcript text using a whitelist as ground truth to fix known speakers, whereas
   our gate uses the whitelist passively to catch invented/misattached names in
   generated output. Worth noting as a design option for later: applying his
   correction technique as a *pre-processing* pass on raw transcripts (before
   synthesis) is a plausible enhancement to explore in Phase 1, separate from and
   complementary to the after-the-fact whitelist gate already planned.
   - He also reports the correction methodology (chain-of-thought "INTERNAL
     THINKING" reasoning steps, evaluated one speaker at a time with surrounding
     dialogue for context, inferring from introductions/references like "I'd like to
     pass the mic to Council Member X" rather than requiring self-introduction)
     took accuracy from roughly 35–50% to 80–90% through iterative prompt
     refinement — i.e., this was hard-won and iterative, not a one-shot prompt.

### License

Not open source; no license applies. Techniques above are documented from the
creator's own public writeup, not from inspecting source code (none is public).

### Informs

Phase 1 prompt design (chapterization prompt-chaining structure, invented
time-marker trick, and the proper-name correction pattern as a possible
pre-processing complement to Gate 1c).

---

## Task → prior-art mapping

| Task | Prior art used |
|------|-----------------|
| 0.1 — Legistar API probe | `opencivicdata/python-legistar-scraper` (pagination, `$filter`/`$orderby` syntax, 410 handling, incremental-sync lookback) and `CouncilDataProject/cdp-scrapers` (full nested event/item/vote/sponsor shape and its mapping onto our `items`/`meta`, plus the `VoteValueId`-is-unreliable and swapped-field quirks) |
| 0.2 — Chino Agenda Center (commissions) | `biglocalnews/civic-scraper` civicplus module (Search-endpoint fallback to RSS, asset-type taxonomy, date-in-anchor-name quirk, link-dedup heuristic) |
| 0.3 — Chino news releases + calendar | `biglocalnews/civic-scraper` civicplus module, same as 0.2 (Search endpoint as a completeness cross-check against RSS) |
| 0.4 — Chino Hills agendas + news | `biglocalnews/civic-scraper` civicplus module, same patterns as 0.2 (same platform) |
| 0.5 — Chino Hills Swagit transcripts | None applicable. Confirmed (not merely assumed) that `cdp-scrapers`' video/caption handling targets Legistar/Granicus-hosted video only, with no Swagit support anywhere in the repos surveyed — consistent with PLAN.md's existing statement that no maintained OSS equivalent exists. `CityMeetings.nyc`'s chapterization/timestamp techniques are relevant to what we *do* with a Swagit transcript once extracted (Phase 1), not to extracting it. |
| 0.6 — CVUSD board | None applicable directly. No repo surveyed has a Finalsite, BoardDocs, or Simbli scraper. `cdp-scrapers/instances/` offers only a loose structural precedent (one file per municipality implementing a common scraper interface) — not concrete porting material. |
| 0.7 — NWS alerts | None applicable. |
| 0.8 — ABC license activity | None applicable. |
| 0.9 — Chino PD / Sheriff releases | None applicable. (Covered indirectly to the extent 0.9 depends on 0.3's CivicAlerts feed, which does draw on civic-scraper per above — but no repo surveyed addresses WordPress `/feed/` scraping or Nixle/social-only channels specifically.) |

---

## What could not be verified

- **Whether Chino Planning Commission agendas live in Legistar, the CivicPlus
  Agenda Center, or both** (PLAN.md open question #2) — none of the five prior-art
  sources have first-hand data on cityofchino.org's actual content; this can only be
  answered by Task 0.2 itself hitting the real site.
- **Whether civic-scraper's `docs/civicplus_sites.csv` is current** — it's a
  point-in-time hand-curated CSV (README notes it's appended-to, not
  auto-regenerated) with no visible last-updated date in the file itself; its
  absence of Chino/Chino Hills rows is evidence about the CSV's subdomain-based
  discovery method (documented above), not proof one way or the other about what
  platform those cities currently run.
- **Whether `python-legistar-scraper`'s rate-limiting behavior is adequate** — the
  API path relies entirely on the `scrapelib.Scraper` base class's retry/backoff
  behavior, which lives in the separate `scrapelib` package and was not read as part
  of this pass (out of scope — the task asked about the Legistar-specific modules).
  If Task 0.1 needs explicit rate-limit tuning, `scrapelib`'s source would need a
  separate look.
- **CDP's actual hosting cost or a partial/self-hosted deployment mode** — the
  verdict above is based on reading `cdp-backend`'s infrastructure-as-config files
  and dependency manifest, not on running or pricing an actual GCP deployment; it's
  possible a heavily stripped-down self-hosted variant exists that avoids Firestore,
  but nothing in the repos surveyed suggests one is supported or documented.
- **Whether CivicPlus's WAF actually blocks non-browser User-Agents** on
  cityofchino.org/chinohills.org specifically — flagged above as a design tension
  with civic-scraper's approach, but not tested against the real sites (out of scope
  for a docs-only research pass).
