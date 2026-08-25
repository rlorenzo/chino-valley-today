# Task 0.9 (Chino Hills half) — SB County Sheriff news releases

Scraper: `src/scrapers/sbsheriff-news.ts` (key `sbsheriff-news`, method `html`).

## Prior art used

None applicable. This source (a modern WordPress multisite for a county sheriff's
department, with press releases distributed via a third-party citizen-notification
platform) isn't covered by the civic-tech scrapers named in PLAN.md Task 0.0
(Legistar/CivicPlus/CivicClerk/Granicus/PrimeGov platform classes). No prior-art
findings ported.

## Probe log (URL -> result)

All probes made with UA `ChinoValleyTodayBot/0.1 (local news POC; contact:
<operator address>)`, 2026-08-11/12. The UA now carries the project address,
`chinovalleytoday@gmail.com`; the probes predate that change.

| URL | Result |
|---|---|
| `https://wp.sbcounty.gov/sheriff/news/feed/` | 404 — PLAN.md's guessed URL. HTML error page, not a 404 from a missing endpoint pattern; the `/news/` path segment doesn't exist at all. |
| `https://wp.sbcounty.gov/sheriff/news/` | 404 |
| `https://wp.sbcounty.gov/sheriff/` | 200 — real site root (Sheriff's Department microsite on the county's WordPress multisite, theme "bolt") |
| `https://wp.sbcounty.gov/` | 302 -> `https://www.sbcounty.gov` (redirect chain confirms `wp.sbcounty.gov` is the live WP host; `www.sbcounty.gov` itself 302s to a legacy `/Main/Default.aspx` ASP.NET site — a dead end for this task) |
| `https://wp.sbcounty.gov/sheriff/feed/` | 200, `content-type: application/rss+xml`, valid WordPress RSS 2.0 envelope, **0 `<item>` elements**. Sends both `ETag` and `Last-Modified` (W3 Total Cache). |
| `https://wp.sbcounty.gov/sheriff/wp-json/wp/v2/types` | 200 — only `post`, `page`, `attachment` (standard WP types; no custom press-release post type) |
| `https://wp.sbcounty.gov/sheriff/wp-json/wp/v2/posts` | 200, `X-WP-Total: 0` (checked via `curl -D -`). **The WordPress "post" content type is completely empty** — this is the definitive finding: whatever posted press releases as WP posts historically has stopped entirely. |
| `https://wp.sbcounty.gov/sheriff/wp-json/wp/v2/categories?per_page=100` | 200 — full taxonomy exists: every SB Sheriff patrol/city station (Adelanto … Yucca Valley, including `chino-hills`), monthly categories back to 2015 (`april-pressreleasesfor2017`, etc.), yearly categories (`pressreleasesfor2015` … `press-peleases-for-2021`, note the site's own typo). **Every single category has `count: 0`.** This taxonomy is a fossil from when press releases were WP posts categorized by station + month/year; it hasn't been used since (categories stop at 2021). |
| `https://wp.sbcounty.gov/sheriff/media-center/` | 200 — hub page, links to the two sub-pages below |
| `https://wp.sbcounty.gov/sheriff/media-center/sheriffs-press-releases/` | 200 — **not a release listing.** Titled "Press Releases By Category," it's a card grid: "Headquarters and Specialized Divisions" (Coroner, Gangs & Narcotics, Headquarters) and "City Stations" / "County Stations" (all ~20 patrol stations). Every card **except Coroner** is `target="_blank"` to `https://local.nixle.com/sbsd---<station-slug>/`. Chino Hills card -> `https://local.nixle.com/sbsd---chino-hills-police-department/`. |
| `https://wp.sbcounty.gov/sheriff/media-center/coroner-press-release/` | 200 — **the one live exception.** A plain WP *page* (id 156, not the empty "post" type) with ~60 case entries embedded directly in the page body as a flat `<ul class="wp-block-list">`, most-recent first. No pagination, no per-item permalink. |
| `https://wp.sbcounty.gov/sheriff/patrol-stations/chino-hills/` | 200 — station's own page corroborates: a prominent "Nixle" badge/button links to the same `local.nixle.com/sbsd---chino-hills-police-department/` URL; no embedded news content on the page itself. |
| `https://local.nixle.com/sbsd---chino-hills-police-department/` | 200 — inspected for characterization only, **not scraped/ingested** (see Nixle disposition below). |
| `https://local.nixle.com/sbsd---chino-hills-police-department/feed/` | 200 but `content-type: text/html` — not a real feed; Nixle serves the same HTML page regardless of the `/feed/` suffix (no WordPress-style feed convention applies here; this is a different, unrelated platform). |
| `https://local.nixle.com/rss/sbsd---chino-hills-police-department/` | 404 |
| `https://nixle.us/HG583` (a message permalink sampled from the channel) | 200 — full release text + absolute Pacific timestamp (`Thursday July 16th, 2026 :: 10:38 a.m. PDT`) on the detail page. Response carries `x-robots-tag: none` (a "don't index in search engines" signal, not a robots.txt block) and is fronted by Cloudflare/CloudFront. |
| `robots.txt` on `wp.sbcounty.gov` | `Disallow: /wp-admin/` only (with explicit `Allow: /wp-admin/admin-ajax.php`). Nothing else blocked — no `skipRobots` needed anywhere in this scraper. |
| `robots.txt` on `local.nixle.com` / `nixle.us` | `Disallow: /region_search/` and `/agency_search/` only. The channel page and message permalinks are **not** blocked. |

## Site structure verdict

The Sheriff's Department press-release *distribution* has moved off the WordPress
site entirely and onto Nixle, one channel per station/division. wp.sbcounty.gov's
own "Press Releases By Category" page and the Chino Hills station page both point
there directly. The WordPress taxonomy (categories per station, per month, per
year, going back to 2015) is a leftover from when releases WERE WP posts; that
stopped sometime after 2021 and posts total is now zero. The only category whose
content still lives on-site is Coroner, embedded as a flat list on a single WP
*page* (not through the post/category/RSS system at all).

## RSS verdict

**Technically present, structurally empty.** `/sheriff/feed/` is a real, valid,
well-formed WordPress RSS 2.0 feed (supports conditional GET via ETag +
Last-Modified) — but it feeds off the "post" content type, which has zero posts.
Not usable for press-release ingestion as the site is currently configured.

## Station taxonomy verdict

**Exists but dead.** A `chino-hills` WordPress category exists (confirmed via
`/wp-json/wp/v2/categories`) alongside every other station, with `count: 0`. The
*live* per-station tagging mechanism today is one Nixle channel URL per station
(`sbsd---chino-hills-police-department`), which is real and current but is not
part of this scraper's ingestion per the Nixle disposition below.

## Nixle disposition (why it's inspected but not scraped)

Task 0.9's own instructions for the Chino PD half say: "If PD has a separate
Nixle/social-only channel, note it as a gap rather than scraping social
platforms." Applying that same policy symmetrically here — Nixle is a
third-party citizen-notification vendor platform, not a page the Sheriff's
Department operates directly, even though it's the department's officially
designated channel for this content.

What was confirmed about it (for the record, in case a future product decision
reverses this policy): the Chino Hills channel (`local.nixle.com/sbsd---chino-
hills-police-department/`) lists messages 20/page, paginated (`?page=2` .. at
least `?page=10` seen), each with a numeric id (`<li id="pub_12530881">`), a
priority tag ("Advisory"), a headline, and a short-link permalink
(`nixle.us/XXXXX`) that resolves to a detail page with full text and an absolute
Pacific-time timestamp. robots.txt does not block any of this. It is real,
current, and — critically — **the only channel currently carrying Chino
Hills-specific Sheriff station news**; nothing else on wp.sbcounty.gov is
station-tagged and live. Each scraper run does one best-effort, un-archived
(`fetchRaw`, not `fetchDocument`) fetch of the channel's first page purely to
report a live item count via `ctx.note()` as a cadence signal — nothing from
Nixle is ever passed to `insertItem`.

## Chino Hills release cadence observation

Zero Chino Hills-tagged or -matching (title/body `/chino hills/i`) items exist in
the only ingested, non-Nixle source (the 60-entry Coroner list) as of this run —
expected, since Coroner releases are county-wide and don't mention station names.
The Nixle channel (not ingested, counted only) showed roughly one message every
1-2 weeks over its visible recent history (relative timestamps like "3 weeks, 5
days ago," "4 weeks ago," "4 weeks ago" for the three most recent messages at
probe time), which is the real Chino Hills Sheriff cadence signal for the
product — currently invisible to this pipeline because of the Nixle policy
above. Recorded as a gap, not silently dropped.

## Ingestion (fallback path taken)

Per Task 0.9 instructions: since zero Chino Hills-tagged/matching releases exist
in the ingestable window, the 5 most recent county-wide Coroner press releases
are stored instead, so the pipeline has real end-to-end sample data. Each item:

- `item_type`: `news_release`
- `external_id`: the numeric case number embedded in the source text (e.g.
  `702605082`) — the only stable per-item identifier this source offers
- `title`: `Coroner press release <id>` (deliberately generic — see privacy
  caveat below; no name/detail extraction into the title)
- `body`: full stripped text of the `<li>` entry, verbatim
- `occurred_at`: parsed from the embedded "On \<Weekday\>, MM/DD/YYYY, at
  H:MM a.m./p.m." pattern, converted from Pacific local time to UTC ISO using a
  computed (not hardcoded) US DST rule so it stays correct for any run year
- `source_url`: the shared listing page URL (see link-back depth note below)
- `meta`: `{ category: 'coroner', stationTag: null, chinoHillsRelevant: false,
  listingUrl, feedUrl: null }`

## Full-text vs. teaser

Not applicable in the RSS sense — the feed is empty. The Coroner page embeds
full release text directly in the page body; there is no separate detail page
and no teaser/full split to characterize.

## Link-back depth (data-quality weakness)

The Coroner page has **no per-item anchor or permalink** — all 60 entries live
in one flat list on one page URL. `source_url` for every ingested item points at
that shared page (`https://wp.sbcounty.gov/sheriff/media-center/coroner-press-
release/`), i.e. document-level link-back, not item-level. This also means the
page has no on-site archive: old entries simply roll off as new ones are added
(observed list spans roughly mid-June through late July 2026, ~60 entries ≈ 6
weeks). `external_id` (the case number) is the only handle idempotency has
across runs once an entry ages off the visible list — if that happens, this
scraper stops seeing it entirely (no way to re-fetch a rolled-off entry from
this source). Noted as an accepted POC-level limitation.

## HTTP behaviors

- robots.txt on `wp.sbcounty.gov` disallows only `/wp-admin/`; nothing in this
  scraper's path required `skipRobots`.
- `/sheriff/feed/` supports conditional GET (`ETag` + `Last-Modified`, via W3
  Total Cache page caching).
- The Coroner and press-release-directory pages send only `Cache-Control:
  max-age=3600` — no `ETag`/`Last-Modified`. Because the Coroner page's content
  changes most runs (rolling window), its `documents` row gets a fresh id most
  runs too; items are pinned to whichever `document_id` first captured their
  `external_id` via a `resolveDocumentId()` helper (same pattern as
  `chinohills-news-rss.ts`'s), so re-runs stay idempotent instead of every
  surviving item looking "new" again.
- No WAF/bot-blocking observed on wp.sbcounty.gov at the enforced 2s/host delay
  with a descriptive User-Agent.

## Tier C privacy caveat

Coroner press release bodies name private individuals (decedents) by full name,
age, and city of residence; at least one entry in the current window names a
minor (age 16, a traffic-collision passenger). Per PLAN.md's Tier C design,
this is exactly the content type that always requires human review before
publishing — no filtering, redaction, or editorializing was performed here.
Source text is stored faithfully and verbatim; the human-review gate exists so
this content never auto-publishes, not so the scraper sanitizes it.

## Failure modes

- If the Coroner page's markup ever changes (different list structure, class
  name), `parseCoronerItems()`'s selector (`ul.wp-block-list > li` with a
  `<strong>NNNNN:</strong>` prefix match) will silently return 0 items rather
  than erroring — worth a periodic manual spot-check.
- If wp.sbcounty.gov ever repopulates the WordPress "post" type with real press
  releases again (station taxonomy is still there, dormant), `/sheriff/feed/`
  and per-station category feeds (`/sheriff/category/chino-hills/feed/` — not
  yet tried since posts=0 makes it moot, but a fast follow-up if posts count
  ever goes non-zero) would become the right primary path and this scraper
  should be revisited.
- The Nixle cadence probe (`fetchRaw`, best-effort) is wrapped in try/catch and
  never fails the run; if Nixle starts blocking this UA, the scraper degrades
  to just not reporting a cadence count, no ingestion impact.

## Verification

- `npx tsc --noEmit` — clean.
- `node src/run-one.ts sbsheriff-news` run twice: first run
  `{"documentsFetched":4,"documentsNew":4,"itemsSeen":5,"itemsNew":5}`; second
  run `{"documentsFetched":4,"documentsNew":1,"itemsSeen":5,"itemsNew":0}`
  (`documentsNew:1` on the second run reflects the Coroner/press-release pages'
  live content changing between runs — expected, and inconsequential given
  `itemsNew:0` confirms item-level idempotency held).
- Spot-checked with `curl -sI`: the shared item `source_url`
  (`.../media-center/coroner-press-release/`), the press-release directory page,
  and the feed URL all return `200 OK`.
