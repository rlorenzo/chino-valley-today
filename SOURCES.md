# SOURCES.md — living registry of sources, endpoints, quirks

Status date: 2026-08-17 (Phase 4 Task 4.1 sources added; original registry
2026-08-11, Phase 0 POC). Per-source deep dives live in
`reports/notes/<key>.md`; this file is the summary registry. Update this file
whenever a source changes behavior.

## Source registry

### chino-legistar — Chino City Council + commissions (Legistar)

- **Method:** Granicus Legistar Web API (`webapi.legistar.com/v1/chino/...`), public, no auth. CONFIRMED LIVE (PLAN open question 1: **yes, API enabled**).
- **Endpoints:** `events?$top=N&$orderby=EventDate desc`, `events/<id>/eventitems?AgendaNote=1&MinutesNote=1`, `eventitems/<id>/votes`, `matters`.
- **Quirks (critical, see reports/notes/chino-legistar.md):**
  - The Web API's `MatterId`/`MatterGuid` do NOT match the InSite website's `LegislationDetail.aspx` ID space. Working item permalinks must be parsed off the meeting's `MeetingDetail.aspx` HTML (keyed by MatterFile).
  - `eventitems/<id>/votes` returns a *different item's* votes (HTTP 200) for consent-calendar members — always verify `VoteEventItemId` matches before storing.
  - Agenda status "Final" does not guarantee items exist (cancelled meetings stay "Final" with 0 items; check `EventComment`).
  - Contains test/placeholder matters ("sample memo", "TEST 1").
  - `MeetingDetail.aspx` embeds fresh `__VIEWSTATE` per render → never byte-stable, expect re-hash on every fetch.
- **Votes:** published (real AYES/NOES with council member names).
- **Link-back depth:** item-level (`LegislationDetail.aspx?ID=...&GUID=...`), meeting-level fallback (`EventInSiteURL`).
- **Reliability guess:** high (stable vendor API).

### chino-agendacenter — Chino CivicEngage Agenda Center (commissions)

- **Method:** HTML listing at `cityofchino.org/agendacenter` + agenda PDFs (`/AgendaCenter/ViewFile/Agenda/_MMDDYYYY-<id>`); PDF text via pdf-parse.
- **Finding:** effectively **dormant** — one category (Community Services Commission), one agenda PDF site-wide (Jan 2022). Planning Commission does NOT publish here (PLAN open question 2: **Planning Commission lives exclusively in Legistar**).
- **Quirks:** robots.txt disallows `/Search`; Agenda Center RSS feeds exist but return 0 items.
- **Link-back depth:** document-level PDF URL with genuine `#page=N`.
- **Reliability guess:** n/a (dormant source; keep for completeness, expect nothing).

### chino-news-rss — Chino news releases + calendar (CivicPlus)

- **Method:** CivicPlus RSS (`/RSSFeed.aspx?ModID=<n>&CID=<ids>`; catalog at `/RSS.aspx` — 20 feeds / 7 modules).
- **Quirks (see reports/notes/chino-news-rss.md):**
  - Newsflash/CivicAlerts descriptions are **teaser-only** (PLAN open question 6: full text requires fetching the detail page).
  - The NR-series press releases (NR26-xxx) have NO RSS feed; the index page links via `conta.cc` (Constant Contact) shortlinks — **permalinks are off-domain** (myemail.constantcontact.com). Real provenance caveat.
  - `RSSFeed.aspx` sends no ETag/Last-Modified and embeds volatile `<lastBuildDate>` → feed documents re-hash every run; item idempotency must come from stable external_ids.
- **Chino PD (Task 0.9):** PD content flows through city CivicAlerts ("Police Spotlights") + "Police Department" calendar category — no separate scrape needed.
- **Link-back depth:** item-level permalinks (CivicAlerts.aspx?aid=N / Calendar.aspx?EID=N / conta.cc for NR-series).
- **Reliability guess:** high for feeds; medium for NR-series (off-domain links).

### chinohills-news-rss — Chino Hills news (CivicPlus)

- **Method:** CivicPlus RSS (`RSSFeed.aspx?ModID=1&CID=...`). Note: `/RSS.aspx` itself is robots-blocked on chinohills.org (catalog enumerated out-of-band); the feed endpoints themselves are fetchable.
- **Quirks:** teaser-only descriptions (117 chars vs 1,606 full text — same open-question-6 answer as Chino); volatile `<lastBuildDate>` re-hashes feed documents every run.
- **Link-back depth:** item-level (`CivicAlerts.aspx?aid=N`, 302s to canonical).
- **Reliability guess:** high.

### chinohills-agendas — Chino Hills agendas (AgendaQuick, NOT CivicPlus)

- **Headline finding (PLAN's assumption was wrong):** Chino Hills' CivicPlus Agenda Center is **decommissioned** (zero categories configured; its own UpdateCategoryList endpoint 500s on every catID). The authoritative agenda system is **AgendaQuick** (Destiny Software) at `agendaquick.chinohills.org:8086`: monthly listing `default.cfm?mt=ALL&month=M&year=Y` → meeting page `agenda.cfm?seq=N` → packet PDF. Laserfiche WebLink holds minutes but is genuinely robots-blocked (blanket `Disallow: /*.aspx`, respected — access gap documented; remedy is asking the City Clerk for allowlisted access).
- **Quirks:** AgendaQuick's robots.txt LOOKS like `Disallow: /` but those lines are a commented-out template example — it is fetchable (scraper header documents this so nobody "fixes" it back). "Agenda" PDFs are actually full packets (1.3MB–65MB, backup materials merged, restarting page numbers) — item split heuristic stops at the first numbering break and was cross-validated against AgendaQuick's clean HTML agenda rendering (exact item-count match on both sampled meetings). Minutes absent from AgendaQuick. Council rows link to Swagit videos (`/videos/<id>`), corroborating the Swagit scraper from the other direction.
- **Link-back depth:** document-level PDF URL with genuine `#page=N`.
- **Reliability guess:** medium-high (undocumented product, but structured and stable-looking; port 8086 URL is unusual — watch it).

### chinohills-swagit — Chino Hills council video transcripts (Swagit)

- **Method:** HTML — server-rendered listing at `chinohillsca.swagit.com` → `/views/<id>`; transcripts embedded in video pages as word-level `data-ts` anchors (`#transcript-fragments`); plain-text `/transcript` download used as the stable archived document.
- **No VTT/JSON caption endpoint exists** (8 shapes probed, all negative — endpoint log in reports/notes/chinohills-swagit.md).
- **Timestamp deep links:** **supported** (PLAN open question 3: `?ts=<seconds>` verified server-side — the response bakes in a `player.currentTime(N)` seek).
- **Quirks:** the new.swagit.com SPA listing renders empty without JS; use the legacy `/views/` path. Video pages embed per-request CSRF tokens → never byte-stable; attach items to the stable `/transcript` document instead.
- **Link-back depth:** timestamp-level (`/videos/<id>?ts=N`).
- **Reliability guess:** medium-high (undocumented but stable-looking endpoints; we are the reference implementation per PLAN).

### cvusd-board + youtube-captions — Chino Valley USD board

- **Method:** meetings index at `chino.k12.ca.us/224768_2` (redirects to current-year page; clean HTML table of Date | Type | Agenda | Minutes | Video) → one `event` item per meeting; yt-dlp auto-captions from the board YouTube channel (UCWKinB4PTb_uskobmwBF8pw) → transcript_segment items with `watch?v=ID&t=Ns` deep links.
- **Open question 4 answered:** neither BoardDocs nor Simbli (and not Finalsite as PLAN guessed) — CVUSD runs **ParentSquare SmartSites**; agenda PDFs are plain static files on `files.smartsites.parentsquare.com`, no board-management API behind them.
- **BLOCKER (policy decision pending):** `files.smartsites.parentsquare.com/robots.txt` is a blanket `Disallow: /` (SEO exclusion on a CDN asset bucket), so agenda-PDF full text is NOT ingested — respected, not bypassed. The item-splitting code is written and hand-validated (hierarchical `II.A.1.` numbering; 21 and 31 items on the two most recent agendas); it activates if a scoped exception is ever approved. Listing-level coverage (19 meetings, working source_urls) works today.
- **Quirks:** channel posts a ~1-min "closed session" stub alongside every full meeting (selection filters by title-date and duration); YouTube rolling-cue VTT needs consecutive-duplicate dedup; minutes live on auth-walled SharePoint personal-share links (dead end, noted).
- **Link-back depth:** timestamp-level for video, document-level for agenda PDFs (listing-level items).
- **Reliability guess:** high for YouTube captions; medium for the meetings page (CMS re-platform risk — it already moved once).

### chino-youtube-captions — City of Chino YouTube (chinotv3)

- **Added 2026-08-12** after reviewing cityofchino.org/167/Stay-Connected: the city's official channel posts full council meetings ("City of Chino Council Meeting - `<date>`") and study sessions, mixed with promo content (filtered by title). Auto-captions via yt-dlp, same shared machinery as the CVUSD channel (src/scrapers/youtube-shared.ts).
- **Why it matters:** completes the Chino recap bundle — Legistar gives agenda+votes, this gives the timestamped transcript (e.g. 2026-07-21 council meeting: 66 agenda items + 30 votes + 586 segments).
- **Quirks:** auto-generated ASR only (no manual caption track) — proper-name garbling applies, Gate 1c is the mitigation; meeting dates parsed from video titles join to Legistar dates.
- **Link-back depth:** timestamp-level (`watch?v=ID&t=Ns`).
- **Reliability guess:** high (city-operated channel, consistent title format).

### nws-alerts — National Weather Service alerts

- **Method:** api.weather.gov JSON API. **Zone CAZ048 covers BOTH Chino and Chino Hills** (PLAN open question 7 answered: the plan's CAZ560 guess was wrong; verified via `/points/33.99,-117.69` and `/points/33.95,-117.73`). County zone CAC071, fire zone CAZ248.
- **Quirks:** requires User-Agent header; robots.txt is a blanket crawler Disallow — documented public API, fetched with explicit skipRobots + justification. Supports ETag.
- **Link-back depth:** item-level (alert `@id` API permalink).
- **Reliability guess:** high.

### abc-licenses — CA ABC license activity

- **Method:** HTML — `abc.ca.gov/licensing/licensing-reports/{new-applications,status-changes}/` server-render a DataTables table for the most recent business day when fetched with NO query string. The table includes hidden-but-present columns, among them a clean plain-text **City** field (PLAN open question 5: **yes, exact-match filterable**, no address parsing needed).
- **Blockers (documented, not bypassed; see reports/notes/abc-licenses.md):**
  - Date selection is a form POST to `/wp-admin/admin-post.php`, which robots.txt disallows (the `Allow: admin-ajax.php` carve-out doesn't cover it).
  - Independently, a Cloudflare edge rule 301-strips ANY query string on any abc.ca.gov URL, killing both `?RPTDATE=` selection and per-license detail links.
  - Net: only the current day's report is fetchable → poll daily (fits the Phase 2 systemd-timer design); no historical backfill; per-license deep links broken (intended URL preserved in `meta.attempted_detail_url`).
- **Provenance caveat:** source_url = the report page, which is NOT date-stable (tomorrow it shows a different day). Flagged against PLAN's citation constraint — Phase 1 should cite the archived raw document alongside the live link.
- **Link-back depth:** document-level, date-unstable (weakest source in the registry on this axis).
- **Reliability guess:** medium (data is clean; access is adversarial-edge-dependent).

### sbsheriff-news — SB County Sheriff (Chino Hills station)

- **Headline finding:** Sheriff press-release distribution has moved OFF the WordPress site onto **Nixle** — one third-party channel per station (`local.nixle.com/sbsd---chino-hills-police-department/`). The WP site's post feed (`wp.sbcounty.gov/sheriff/feed/`) is valid RSS but structurally empty (0 posts ever); the "Chino Hills" WP category is dead (count 0, last used ~2021). PLAN's `/sheriff/news/feed/` guess is stale (404).
- **Nixle disposition (decision 2026-08-12):** recognized as a PRIMARY source (the department's official press channel), but NOT scraped — Everbridge's Nixle resident ToS expressly prohibits automated scraping of Service web pages (search engines excepted; verified in the ToS text 2026-08-12). Ingestion path: **email subscription** to the Chino Hills channel (the service's intended delivery mechanism), parsed from a mailbox we control; source_url = the nixle.us permalink carried in each message. Page-structure groundwork (permalinks, timestamps, cadence) recorded in reports/notes/sbsheriff-news.md. **Cadence correction (2026-08-17):** the "~1 msg per 1-2 weeks" figure overstates what was measured. The 2026-08-12 probe saw the three most recent messages at "3 weeks 5 days ago", "4 weeks ago", "4 weeks ago" — a mid-July cluster followed by silence, i.e. bursty with month-long gaps, not weekly. The channel has published nothing since ~2026-07-16, which predates our subscription and explains the empty safety topic.
- **sbsheriff-nixle-mail (built 2026-08-13):** a controlled mailbox is subscribed (the address is deployment config in .env, not tracked here); ingester `src/scrapers/sbsheriff-nixle-mail.ts` (key `sbsheriff-nixle-mail`, method `email`) polls Gmail over IMAP (imapflow + mailparser, read-only BODY.PEEK — never flags/moves/deletes), matches on the +nixle alias or a Nixle sender, stores the raw .eml content-addressed, and ingests ONLY messages carrying a nixle.us permalink (external_id = the permalink code; confirmations/service mail skipped — provenance rule). All items Tier C (`meta.tier`). Skips cleanly with a note when NIXLE_IMAP_USER/PASSWORD are unset in .env.
- **Template assumptions were wrong — corrected 2026-08-17 against real mail.** The source ingested 0 items for its first four days while reporting "no Nixle messages found yet". Three errors, all from reading the shape off the web channel page rather than an email:
  - **Permalink:** emails carry `https://local.nixle.com/alert/<numeric id>/?sub_id=0`, NOT the `nixle.us/<CODE>` short link. external_id is now the numeric alert id. The short-link form is kept as a fallback but has never been observed in mail.
  - **Subject prefix:** real subjects read `Advisory Message: …`, not `Advisory: …`, so `meta.priority` was silently null on everything.
  - **Channel:** the Chino Hills channel URL was hardcoded into every item's `meta.channel`. It is now derived per message from the sender local part (`sbsd---headquarters@emails.nixle.com` → `sbsd---headquarters`), because the mailbox receives more than one channel.
  - HTML parts wrap every link in AWS `awstrack.me` click tracking with the target percent-encoded; the permalink patterns deliberately do not match those, so source_url stays a clean canonical URL.
- **Scope discovery (2026-08-17):** a Nixle subscription delivers every agency channel covering the subscribed area. Live mailbox contents are dominated by **SBSD - Headquarters** (county-wide) and **SBSD - Central**, carrying releases for Loma Linda, Mentone, Hesperia, and Rialto. First real run: 6 items, **0 of 6 mentioning Chino or Chino Hills**. The Chino Hills station channel has published nothing since the 2026-08-13 subscription. Everything is ingested with `meta.chinoRelevant` flagged, not filtered (same policy as sbcfire-news).
- **Publishing (operator decision 2026-08-17):** these auto-publish in full, body text included, without the Tier C per-item acknowledgment — see EDITORIAL.md "Agency alert channels". Generator is `src/tiera/nixle-releases.ts`; it publishes only `chinoRelevant` releases from the last 30 days and holds anything indicating a minor.
- **What IS ingested:** the one live on-site source — county-wide Coroner press releases (`/sheriff/media-center/coroner-press-release/`, rolling ~6-week window, no per-item permalinks — all items share the page URL, a documented link-depth limitation).
- **Editorial note:** Tier C source — bodies name private individuals (incl. minors) verbatim; human review always required (see PLAN Phase 1).
- **Link-back depth:** document-level only (no per-item permalinks on the Coroner page).
- **Reliability guess:** low for Chino Hills specificity (the station-specific channel is off-limits by policy); the practical Chino Hills police-news channel decision belongs in Phase 1 editorial rules.

### chino-p2c — Chino PD "Police to Citizen" portal (PROBED, NOT INGESTED)

- **Probed 2026-08-17** (full log: `reports/notes/chino-p2c.md`) while investigating an empty safety topic. Chino PD is a **municipal department**, not an SBSD contract station — so unlike Chino Hills, no Chino police news will ever arrive through the Nixle channels. There is currently **no incident-level Chino PD source in this registry**.
- **Finding:** `p2c.cityofchino.org` runs CentralSquare P2C with the data modules switched off. `/summary.aspx` (event search) and `/dailybulletin.aspx` both 302 back to `/main.aspx` — present in the build, disabled. `/arrest.aspx`, `/warrants.aspx`, `/inmate.aspx`, `/cadcalls.aspx` 302 to `/PageNotFound.aspx` — not installed. Only the citizen incident-reporting module is live.
- **robots.txt is permissive** (`Disallow: /admin/` only). This is a publishing choice by the city, not a policy or technical block — the distinction that makes it an *ask*, not a workaround.
- **Live lead:** `/jqHandler.ashx?op=s` returns 200 with a well-formed jqGrid envelope (`{"total":"0","records":"0","rows":[]}`) — the data backend is wired, its backing module just has nothing enabled behind it. If the city ever turns on the daily bulletin, that endpoint is the likely structured-JSON path.
- **Remedy (same shape as the CVUSD and Laserfiche gaps):** ask Chino PD's PIO or the City Clerk whether the daily bulletin and event search can be enabled for public view. Nothing to scrape in the meantime.
- **Link-back depth:** n/a (not a source yet).

### nws-forecast — NWS daily forecast (both cities)

- **Added 2026-08-17 (Phase 4).** Same documented API as nws-alerts, same
  skipRobots justification. Gridpoints verified via `/points`: Chino →
  `SGX/47,73`, Chino Hills → `SGX/45,71` (adjacent cells; both ingested,
  city-tagged in meta).
- **Quirks:** forecast periods churn on every NWS update; items refresh in
  place via (document url, item_type, external_id) with external_id =
  `<grid>:<period start ISO>`. source_url is the reader-facing
  forecast.weather.gov MapClick page, not the JSON API URL.
- **Link-back depth:** document-level (city forecast page; period-level anchors
  don't exist on MapClick).
- **Reliability guess:** high.

### sbcfire-news — San Bernardino County Fire news

- **Added 2026-08-17 (Phase 4).** Standard WordPress RSS at `sbcfire.org/feed/`
  — press releases, major-incident news, PIO podcasts. County-wide; Chino
  Valley relevance flagged in `meta.chinoRelevant`, not filtered at ingest.
- **Quirks:** feed carries full article HTML in `content:encoded` (unlike the
  CivicPlus teasers) — the scraper reads it directly; robots.txt fetch was
  bot-blocked to an external recon tool but the pipeline's own client fetches
  the site normally.
- **Link-back depth:** item-level (stable WordPress slugs).
- **Reliability guess:** high.

### cvfd-news — Chino Valley Fire District (CivicPlus)

- **Added 2026-08-17 (Phase 4).** Third CivicPlus instance in the registry;
  feed catalog is openly enumerable at `/RSS.aspx` (NOT robots-blocked here,
  unlike cityofchino.org). Ingests News Flash (news_release), Alert Center
  (alert), Calendar (event). Agenda Center (ModID=65, per-committee feeds)
  deliberately left for a future governance scraper.
- **Quirks:** all three feeds were empty on the first run — the district posts
  sparingly, and an empty Alert Center is the desired steady state (a non-empty
  run is an active emergency). Calendar items get occurred_at from
  `calendarEvent:EventDates/EventTimes` (Pacific local → UTC via the shared
  `localDateTimeToIso`), falling back to pubDate.
- **Link-back depth:** item-level (CivicAlerts.aspx?AID / Calendar.aspx?EID).
- **Reliability guess:** high (platform proven twice over); content volume low.

### sbclib-events / sbparks-events / cbwcd-events / yanksair-events — Tribe Events calendars

- **Added 2026-08-17 (Phase 4).** Four WordPress + The Events Calendar sites
  sharing one scraper core (`src/scrapers/tribe-events.ts`): REST API at
  `/wp-json/tribe/events/v1/events`, stable per-event permalinks, structured
  categories. First run: 152 + 2 + 20 + 4 events respectively.
  - **sbclib-events** — `library.sbcounty.gov`, venue-scoped to Chino (1181),
    Chino Hills/Thalman (1250), Cal Aero (1241). **Never use sbclib.org** — its
    Cloudflare WAF 403s everything, including real browsers; the county
    hostname serves the identical WordPress openly.
  - **sbparks-events** — `parks.sbcounty.gov`, venue-scoped to Prado (1897).
  - **cbwcd-events** — `cbwcd.org`, whole calendar (the district IS the
    coverage area): Water Wednesdays, compost giveaways, free workshops.
  - **yanksair-events** — `yanksair.org`, whole calendar. robots.txt lives at
    the `www.` hostname only and asks `Crawl-delay: 10` (honored via an extra
    8s request gap on top of politeFetch's 2s floor).
- **Quirks:** the events JSON re-hashes as dates roll → fresh document every
  run; items pin to first capture via resolveDocumentId. external_id is
  `<event id>:<utc_start_date>` because per-occurrence id uniqueness for
  recurring events was not verified.
- **Link-back depth:** item-level (`/event/<slug>/[<date>/]`).
- **Reliability guess:** high (county sites match the proven sheriff/library
  infra); medium for yanksair (small-org WordPress).

### champion-news — The Champion Newspapers (TownNews Blox CMS)

- **Added 2026-08-18 (Phase 4 Task 4.2).** Weekly community newspaper covering
  Chino and Chino Hills. Ingests Saturday edition sitemaps from
  `championnewspapers.com/tncms/sitemap/editorial.xml` (capped at 15 candidate
  articles/run).
- **Quirks & Policy (see reports/notes/champion-news.md):**
  - Fail-closed robots compliance (`failClosedRobots: true`) and redirect protection.
  - Terms of service tracked in `source_tos_status` with weekly drift checks (`scripts/check-tos-drift.ts`).
  - Summaries are sentence-bounded teasers ($\le 280$ chars, $\le 40$ words) for attribution. Secondary press links wear crate styling (`.stamp--attribution`), never violet.
  - Silent-drift alarm: three consecutive failed runs, or three consecutive runs that succeed while extracting 0 items, fail the brief watchdog unit (`checkDegradedSources`).
- **Link-back depth:** item-level (`/community_news/article_<uuid>.html`).
- **Reliability guess:** high (stable TownNews sitemaps).

### dailybulletin-news — Inland Valley Daily Bulletin (MediaNews Group WordPress)

- **Added 2026-08-18 (Phase 4 Task 4.2).** Regional daily newspaper covering
  Chino and Chino Hills municipal news. Ingests articles from dedicated Chino
  and Chino Hills location hubs (`/location/california/san-bernardino-county/...`,
  capped at 15 candidate articles total/run).
- **Quirks & Policy (see reports/notes/dailybulletin-news.md):**
  - Fail-closed robots compliance (`failClosedRobots: true`) and redirect protection.
  - Terms of service tracked in `source_tos_status` with weekly drift checks (`scripts/check-tos-drift.ts`).
  - Summaries are sentence-bounded teasers ($\le 280$ chars, $\le 40$ words) for attribution.
  - Cross-outlet deduplication gives Champion precedence when covering the same story.
  - Silent-drift alarm: three consecutive failed runs, or three consecutive runs that succeed while extracting 0 items, fail the brief watchdog unit (`checkDegradedSources`).
- **Link-back depth:** item-level (`/YYYY/MM/DD/article-slug/`).
- **Reliability guess:** high.

## Open questions from PLAN — answers so far

1. **Legistar API enabled for Chino?** YES — confirmed live, built on it.
2. **Where do Chino Planning Commission agendas live?** Legistar exclusively (Agenda Center is dormant: 1 PDF since 2022; PC never listed there).
3. **Does Swagit expose VTT/JSON captions and timestamp deep links?** No structured caption endpoint exists; transcripts are embedded HTML with word-level timestamps. Deep links: YES, `?ts=<seconds>` (server-side verified).
4. **Is CVUSD on BoardDocs/Simbli?** Neither — ParentSquare SmartSites CMS, plain static agenda PDFs (no structured backend). PDF asset host is robots-blocked (policy decision pending on a scoped exception).
5. **ABC report format / city filterability?** Server-rendered HTML DataTables; premises City is a clean exact-match column (hidden from the widget, present in raw HTML). Only the most recent business day is reachable (date selection blocked by robots + Cloudflare query-stripping).
6. **Do CivicPlus RSS feeds include full text?** NO — teaser-only for Newsflash/CivicAlerts (Chino confirmed; Chino Hills same platform). Full text requires detail-page fetch. Calendar feed descriptions are effectively complete.
7. **Correct NWS zone(s)?** CAZ048 for both cities (same zone, valley + hills; PLAN's CAZ560 guess wrong).

## Prior art

Full writeup: `reports/notes/prior-art.md` (per-repo findings, licenses, task mapping). Summary of what was used:

- **biglocalnews/civic-scraper** (Apache-2.0) — CivicPlus Agenda Center URL patterns (`/AgendaCenter/ViewFile/Agenda/_MMDDYYYY-<id>`, date-in-anchor-name parsing) ported into Tasks 0.2/0.4.
- **opencivicdata/python-legistar-scraper** (BSD-3) — Legistar Web API pagination/$filter conventions informed Task 0.1 (API branch).
- **CouncilDataProject/cdp-scrapers** (MPL-2.0) — event/minutes/votes JSON shape informed our items/meta layout. **Verdict: do NOT run a CDP instance** — cdp_backend hard-requires GCP (Firestore/Cloud Functions/Pulumi); incompatible with the cheap-VPS constraint.
- **City-Bureau/city-scrapers** (MIT) — meeting-spec comparison. **Schema verdict: keep our documents/items split** (more granular, provenance-first). Adopted recommendations: add nullable `documents.location` and `documents.event_key` before Phase 1 freeze; cancelled-meeting status can live in meta for now.
- **CityMeetings.nyc** (not OSS; talks/writeups) — chapterization + proper-name-error handling patterns recorded for Phase 1 Gate 1c (proper-name whitelist) design.

Contribution targets (post-POC, per PLAN): the Swagit transcript extractor (no maintained OSS equivalent exists — ours documents the endpoint landscape) and the gating layer as a standalone pattern/package.
