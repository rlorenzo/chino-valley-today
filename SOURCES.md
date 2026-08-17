# SOURCES.md — living registry of sources, endpoints, quirks

Status date: 2026-08-11 (Phase 0 POC). Per-source deep dives live in
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
- **Nixle disposition (decision 2026-08-12):** recognized as a PRIMARY source (the department's official press channel), but NOT scraped — Everbridge's Nixle resident ToS expressly prohibits automated scraping of Service web pages (search engines excepted; verified in the ToS text 2026-08-12). Ingestion path: **email subscription** to the Chino Hills channel (the service's intended delivery mechanism), parsed from a mailbox we control; source_url = the nixle.us permalink carried in each message. Page-structure groundwork (permalinks, timestamps, ~1 msg per 1-2 weeks cadence) recorded in reports/notes/sbsheriff-news.md.
- **sbsheriff-nixle-mail (built 2026-08-13):** mailbox <chinovalleytoday+nixle@gmail.com> subscribed; ingester `src/scrapers/sbsheriff-nixle-mail.ts` (key `sbsheriff-nixle-mail`, method `email`) polls Gmail over IMAP (imapflow + mailparser, read-only BODY.PEEK — never flags/moves/deletes), matches on the +nixle alias or a Nixle sender, stores the raw .eml content-addressed, and ingests ONLY messages carrying a nixle.us permalink (external_id = the permalink code; confirmations/service mail skipped — provenance rule). All items Tier C (`meta.tier`). Skips cleanly with a note when NIXLE_IMAP_USER/PASSWORD are unset in .env. Email template assumptions (subject priority prefix, permalink placement) are pinned by fixture tests but unverified against a real alert until the first one arrives (~1-2 week cadence).
- **What IS ingested:** the one live on-site source — county-wide Coroner press releases (`/sheriff/media-center/coroner-press-release/`, rolling ~6-week window, no per-item permalinks — all items share the page URL, a documented link-depth limitation).
- **Editorial note:** Tier C source — bodies name private individuals (incl. minors) verbatim; human review always required (see PLAN Phase 1).
- **Link-back depth:** document-level only (no per-item permalinks on the Coroner page).
- **Reliability guess:** low for Chino Hills specificity (the station-specific channel is off-limits by policy); the practical Chino Hills police-news channel decision belongs in Phase 1 editorial rules.

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
