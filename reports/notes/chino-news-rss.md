# Task 0.3 — Chino news releases + calendar (CivicPlus RSS) + Task 0.9 (Chino PD half)

Scraper: `src/scrapers/chino-news-rss.ts` (key `chino-news-rss`). Site: `cityofchino.org`,
CivicPlus/CivicEngage platform. Research + implementation date: 2026-08-11.

## Feed catalog (full enumeration from `RSS.aspx`)

`https://www.cityofchino.org/RSS.aspx` is the CivicPlus feed-discovery page. It lists
**20 feeds across 7 modules**. This page is **disallowed by robots.txt**
(`Disallow: /RSS.aspx`), confirmed live by the scraper itself on every run (it attempts
the fetch and logs the block via `ctx.note()` rather than using `skipRobots`, which is
reserved for documented public APIs — this isn't one). The catalog below was therefore
hand-enumerated once, out-of-band, by reading that same page with `curl` as a one-time
human research step, not by the scraper. The individual feed endpoints it links to
(`/RSSFeed.aspx?ModID=...&CID=...`) are **not** covered by any robots.txt rule and are
fetched normally.

| Module (ModID) | Category (CID) | URL |
|---|---|---|
| Newsflash/CivicAlerts (1) — nav label "Spotlights", RSS `<title>` "News Flash" | All | `/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml` |
| | Chino Spotlights | `/RSSFeed.aspx?ModID=1&CID=Chino-Spotlights-1` |
| | Community Services Spotlights | `/RSSFeed.aspx?ModID=1&CID=Community-Services-Spotlights-7` |
| | Fact Page | `/RSSFeed.aspx?ModID=1&CID=Fact-Page-10` |
| | **Police Spotlights** | `/RSSFeed.aspx?ModID=1&CID=Police-Spotlights-8` |
| | Success Stories | `/RSSFeed.aspx?ModID=1&CID=Success-Stories-9` |
| Blog (51) | All | `/RSSFeed.aspx?ModID=51&CID=All-blog.xml` |
| Photo Gallery (53) | All | `/RSSFeed.aspx?ModID=53&CID=All-0` |
| | 2020 Halloween Spooktacular | `/RSSFeed.aspx?ModID=53&CID=2020-Halloween-Spooktacular-4` |
| | 2021 Corn Feed Run Car Show & Cruise | `/RSSFeed.aspx?ModID=53&CID=2021-Corn-Feed-Run-Car-Show-Cruise-3` |
| | Ruben S. Ayala Park | `/RSSFeed.aspx?ModID=53&CID=Ruben-S-Ayala-Park-2` |
| Calendar (58) | All | `/RSSFeed.aspx?ModID=58&CID=All-calendar.xml` |
| | Community Services | `/RSSFeed.aspx?ModID=58&CID=Community-Services-27` |
| | Events | `/RSSFeed.aspx?ModID=58&CID=Events-14` |
| | Meetings | `/RSSFeed.aspx?ModID=58&CID=Meetings-24` |
| | **Police Department** | `/RSSFeed.aspx?ModID=58&CID=Police-Department-26` |
| Alert Center (63) | All | `/RSSFeed.aspx?ModID=63&CID=All-0` |
| | Non Emergency Items | `/RSSFeed.aspx?ModID=63&CID=Non-Emergency-Items-6` |
| Agenda Center (65) | All | `/RSSFeed.aspx?ModID=65&CID=All-0` |
| | Community Services Commission | `/RSSFeed.aspx?ModID=65&CID=Community-Services-Commission-2` |
| Pages (76) | All | `/RSSFeed.aspx?ModID=76&CID=All-0` |

All URLs relative to `https://www.cityofchino.org`.

**Important finding — the catalog has no "News Releases" module at all.** The numbered
`NR26-xxx` press-release series PLAN.md's Task 0.3 assumed would be in RSS **is not
represented anywhere above**. See "NR-series" section below.

## What was ingested

- **Newsflash/CivicAlerts, 5 named categories** (Chino Spotlights, Community Services
  Spotlights, Fact Page, **Police Spotlights**, Success Stories) — fetched
  individually rather than the aggregate "All" feed so each item's real category is
  known (the "All" feed carries no `<category>` element). `item_type: 'news_release'`.
  The aggregate "All" feed is also fetched, but only as a cross-check total in a
  `ctx.note()` — not used to create items, to avoid the same item being inserted
  twice under two different documents.
- **Calendar, "All" feed** — `item_type: 'event'`, using the feed's custom
  `calendarEvent:EventDates` / `EventTimes` / `Location` XML-namespace fields for
  structured date/time/location rather than the free-text `<description>`.
- **Calendar, "Police Department" category** — fetched and counted for Task 0.9
  evidence only (0 items at run time); not a separate item-creation path.
- **NR-series press releases** — HTML fallback from `/597/News-Releases` (see below),
  most recent 2 releases, `item_type: 'news_release'`.
- **Not ingested**: Blog, Photo Gallery, Alert Center, Agenda Center, Pages. Agenda
  Center is Task 0.2's scraper's territory (`chino-agendacenter.ts`), not ours. The
  rest were empty or out of scope for a news/calendar scraper at survey time.

## Open question 6 — full text or teaser-only?

**Teaser-only** for Newsflash/CivicAlerts RSS. Measured directly by fetching the item
detail page and diffing lengths:

- "Community Academy": RSS `<description>` = 155 chars; full article extracted from
  the detail page = 839 chars (event details, eligibility list, application link —
  none of it in the feed).
- "Business License Reform & Small Business Protection Measure": RSS
  `<description>` = 229 chars; full page text = 17,169 chars (this one links out to a
  full CMS "Pages" article, not a Newsflash detail template — see extraction-quality
  note below on why that number is inflated).

**Calendar feed descriptions are effectively complete** — a calendar entry's whole
content *is* its date/time/location, and the feed's `<description>` (plus the
namespaced fields) already contains that in full.

**NR-series has no RSS description at all**, because it has no feed (see below) — 0%
of its content is available without fetching the linked page.

## Task 0.9 (Chino PD half) — does PD content flow through the CivicAlerts feed?

**Yes, via a dedicated "Police Spotlights" category** (Newsflash module, ModID=1,
`CID=Police-Spotlights-8`), confirmed live: it currently contains "Community Academy"
(a 10-week citizen police academy announcement). The Calendar module also carries a
parallel "Police Department" category (ModID=58, `CID=Police-Department-26`, 0 items
at run time).

Caveats:

- Content observed is **community-outreach/recruiting** (academy sign-ups, events),
  not incident or crime press releases. Chino PD does not appear to publish
  incident-level reports through this RSS surface.
- No separate PD press-release or incident feed exists anywhere in the RSS.aspx
  catalog. **Treated as a GAP**: if Chino PD publishes incident-level information at
  all, it is outside RSS — not verified further here per scope (social platforms
  explicitly excluded, per PLAN.md).

## NR-series press releases — off-domain permalink finding

`/597/News-Releases` is a hand-maintained CMS page (year-headed `<h2>` sections, most
recent first) listing the numbered NR-series (currently 50 releases just in the 2026
section, `NR26-001`–`NR26-051`). **Every link on it is a `conta.cc` shortlink**
(Bitly, fronting Constant Contact — Chino apparently distributes its official press
releases as an email newsletter and republishes the shortlinks on this page). Each
resolves via a **301** to `myemail.constantcontact.com/...` — a hosted email-campaign
page, entirely off `cityofchino.org`.

This directly contradicts the assumption in PLAN.md/Task 0.3 that "one item per
release with permalink" would come from an on-domain RSS feed: **the real release
permalink for this series is a third-party (Constant Contact) URL, and there is no
RSS feed for it anywhere on the site.** This is treated as the HTML-fallback case
PLAN.md's Task 0.3 anticipated ("if RSS is missing, scrape /597/News-Releases"),
applied specifically to this series since RSS genuinely doesn't cover it (RSS itself
is not broken/missing for the site overall — Newsflash and Calendar both work fine).

`item.source_url` for these items is the `conta.cc` shortlink (what's actually
published and what a reader would click), which satisfies PLAN.md's own
`items.source_url` definition ("the deepest stable link available") — but it is not
a government domain, and `meta.resolvesTo` records the final Constant Contact URL for
transparency. `robots.txt` for both `conta.cc` (Bitly: wide open) and
`myemail.constantcontact.com` (Constant Contact: only disallows `/blog/`, `/legal/`,
`/opt-out*` — none of which match) permit fetching these pages.

Content quality there is actually excellent once extracted: full press-release text
with dateline, quotes, and a named press contact (e.g. "CHINO, CA (July 28, 2026) —
Approximately 513 Chino Valley students..."). One real-world data-quality wrinkle
observed: the index page's title for NR26-051 doesn't include a `[CORRECTED]` prefix
that the actual Constant Contact page's title has — the index page appears not to
always get updated when the source content is corrected after publication.

## Extraction quality (cheerio)

- **Newsflash detail pages** use two different CivicPlus templates depending on
  whether the item's "read more" target is a Newsflash article or an existing CMS
  page: the newer "redesign" template renders article body under
  `#main-wrapper .article-content` (clean, high confidence — this is what produced
  the 839-char "Community Academy" figure above). Items that link out to a generic
  Pages-module page instead have no such container (grid/widget layout); the scraper
  falls back to whole-`#moduleContent` text extraction, noted explicitly as lower
  confidence (this is what produced the 17,169-char "Business License Reform" figure
  — real content, but includes page chrome/widgets beyond the article itself, so
  that number overstates true article length).
- **NR-series (Constant Contact) pages** are table-based marketing-email HTML with no
  semantic article container. Extraction strips `<script>`/`<style>`, takes
  `body` text, and truncates at the first `"Unsubscribe"` occurrence (the compliance
  footer marker present at the end of every sampled page). This reliably removes the
  email chrome but is a heuristic, not a real selector — a more targeted approach
  would be worth it if this becomes a maintained scraper rather than a POC.

## HTTP behaviors

- `RSSFeed.aspx` responses send **no `ETag`, no `Last-Modified`**
  (`cache-control: private,no-transform` — explicitly marked non-cacheable). No
  conditional-GET support observed anywhere on this platform for these endpoints.
- **Platform quirk, worth knowing for sibling CivicPlus scrapers** (`chino-
  agendacenter.ts`, `chinohills-agendas.ts`, `chinohills-news-rss.ts`): every
  `RSSFeed.aspx` response embeds a live `<lastBuildDate>` that changes on every
  request, so the feed *document*'s content hash never matches across runs —
  `documentsFetched`/`documentsNew` for feed URLs will be equal on every run, by
  design of the source, not a scraper bug. Similarly, the *older* WebForms template
  (e.g. `Calendar.aspx?EID=...`) embeds a live, encrypted `__VIEWSTATE` field and is
  equally non-reproducible byte-for-byte. The *newer* "redesign" template (Newsflash
  detail pages, Pages module, `/597/News-Releases`) has neither and fetches
  byte-identically across requests.
  - Consequence: naively keying item identity off "the document I just fetched"
    breaks idempotency for anything sourced from a live feed (an item would look
    "new" every run even though nothing changed). Fixed here with
    `resolveDocumentId()`, which looks up (via `ctx.db`, already exposed on
    `ScraperContext`) whether an item with this `external_id` already exists under
    this source and, if so, reuses *that* row's `document_id` instead of the
    freshly-fetched one — so `insertItem`'s `UNIQUE(document_id, external_id,
    item_type)` key still matches and updates in place. Each run's feed fetch is
    still archived as its own real document (accurately reflecting the resource
    genuinely changed); only the item's document linkage is pinned to where it was
    first captured.
- No WAF/bot-blocking behavior observed anywhere: no CAPTCHA, no 403s, for a plain
  descriptive `User-Agent` at the enforced 2s/host delay.
- Newsflash item links use standard 301/302 redirects to canonicalized or
  "mobile-template" URLs (e.g. `/1777` → `/1777/Business-License-Reform-...`,
  `/CivicAlerts.aspx?aid=409` → `/m/newsflash/home/detail/409`); the fetcher's
  `redirect: 'follow'` handles these transparently.

## Failure modes / known limitations

- **RSS.aspx itself cannot be fetched** (robots.txt disallow) — the scraper verifies
  this live every run and falls back to the hand-enumerated catalog above rather than
  crashing or bypassing robots.
- **Feed-document volatility** (see HTTP behaviors) required a workaround
  (`resolveDocumentId`) to keep item idempotency; documented there.
- **Two duplicate/orphaned item rows exist in the shared project DB** (`data/
  cvtoday.db`) from an early version of this scraper, before a duplicate-insert bug
  was fixed (a two-pass insert — teaser then full-text — created a second row instead
  of updating in place, because the two passes used different `document_id`s). The
  bug was fixed before the final scraper code shipped and is verified clean in an
  isolated scratch DB (3 consecutive runs: 7 new → 0 new → 0 new). The 2 stale rows
  from the buggy run (ids visible via `SELECT * FROM items WHERE document_id IN (11,
  14)`) are harmless — they're simply not updated or referenced by the current code
  — but I could not clean them up: a scoped `DELETE` against the shared database was
  blocked by the permission system as a destructive action, and this DB may be
  written concurrently by sibling scraper tasks. **Someone with delete authority
  should run**: `DELETE FROM items WHERE document_id IN (SELECT id FROM documents
  WHERE source_id = (SELECT id FROM sources WHERE key='chino-news-rss')) AND id NOT
  IN (<the 7 current item ids>)`, or just accept them as harmless clutter.
- **NR-series volume is much larger than what's ingested**: 50 releases were found
  in the 2026 section alone; only the 2 most recent are ingested (POC volume bound).
  A production version would want to backfill and paginate into prior years.
- Only 2 live items existed site-wide in Newsflash/CivicAlerts at survey time (a
  quiet week), so the "5-10 sample items" target was reached by combining streams
  (Newsflash + NR-series + Calendar) rather than from one feed alone.

## Prior art

`reports/notes/prior-art.md` (Task 0.0, produced by a sibling task) documents that
`biglocalnews/civic-scraper`'s CivicPlus module **does not use RSS at all** — it POSTs
to a server-rendered `/Search/` endpoint and scrapes HTML instead, because (per that
research) CivicPlus's own RSS coverage is inconsistent across sites. That wasn't
directly applicable here since Task 0.3 specifically chartered the RSS path and
cityofchino.org's RSS turned out to work well for Newsflash and Calendar — but it's a
useful data point for `chino-agendacenter.ts` (Task 0.2) or any future scraper on this
platform that finds RSS insufficient: the `/Search/` endpoint pattern from that repo
is the documented alternative. No other prior-art repo (Legistar tooling, CDP
scrapers, city-scrapers) covers CivicPlus RSS/Newsflash/Calendar specifically, so
nothing else from that research was ported here.

## Verification

- `npx tsc --noEmit`: clean.
- Idempotency, verified twice — once cleanly in an isolated scratch DB (`CVT_DB=
  <scratch path>`, 3 consecutive runs: `itemsNew` 7 → 0 → 0), and again against the
  real project DB (`itemsNew` 0 → 0, reflecting state already settled from earlier
  runs during development — see "known limitations" above for the 2 harmless
  orphaned rows this history left behind).
- Final real-DB run counts: `{"documentsFetched":13,"documentsNew":8,"itemsSeen":7,
  "itemsNew":0}`. `documentsNew` staying at 8 every run is expected (see the
  feed-volatility note above) — it counts the 8 live-feed fetches (5 Newsflash
  categories + 1 aggregate cross-check + Police-Department calendar category + "All"
  calendar), each of which genuinely returns new bytes every request.
- 7 current items: 4 `news_release` (2 Newsflash/CivicAlerts with full text, 2
  NR-series with full text) + 3 `event` (Calendar).
- Spot-checked 3 `source_url`s with `curl -sI -L` (following redirects, matching how
  a reader would actually land): all resolve.
  - `https://conta.cc/4pJ4bR9` → 301 → `myemail.constantcontact.com/City-of-Chino-
    News-Release.html?...` → final **200**.
  - `https://www.cityofchino.org/Calendar.aspx?EID=1882` → **200** directly.
  - `https://www.cityofchino.org/CivicAlerts.aspx?aid=409` → 302 →
    `/m/newsflash/home/detail/409` → final **200**.

## Alert Center ingestion (2026-08-19, Task 4.6)

Probe (pipeline UA, robots read mechanically first):
`https://www.cityofchino.org/RSSFeed.aspx?ModID=63&CID=All-0` → HTTP 200,
valid RSS 2.0, 0 items, channel title "Chino, CA - Alert Center". robots.txt
confirms `Disallow: /RSS.aspx` (catalog page) for all agents; `RSSFeed.aspx`
endpoints remain unlisted and allowed — same posture the scraper has
documented since Phase 0.

Phase 0 skipped this module as "empty at survey time". Reversed: an Alert
Center's value is being subscribed *before* the non-empty day (CVFD
precedent — empty is the healthy steady state, a non-empty run is an active
emergency). Ingested as `alert` items. Caveat: `All-0` is the CVFD-pattern
CID confirmed live against the endpoint; the robots-blocked catalog means
per-category alert feeds, if any, are unverified — a one-time manual browser
check of /RSS.aspx would close that.
