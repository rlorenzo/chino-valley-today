# Task 0.8 — California ABC license activity (business early-warning)

Scraper: `src/scrapers/abc-licenses.ts` (key `abc-licenses`). Site: `www.abc.ca.gov`,
WordPress (WP Engine hosting, behind Cloudflare) with a custom "lqs" (license query
system) plugin. Research + implementation date: 2026-08-11.

## Prior art used

None applicable. `reports/notes/prior-art.md` already records this for Task 0.8
(biglocalnews/civic-scraper and friends are city-council-platform focused; nothing
in the surveyed repos covers a state ABC license-query system).

## The reverse-engineered endpoint

Report pages exist at `https://www.abc.ca.gov/licensing/licensing-reports/<slug>/`
(confirmed live: `new-applications`, `status-changes`; the index page lists more
siblings, not probed further — out of scope for this task).

Each page embeds a `<form id="daily-license-report-form" method="post"
action="https://www.abc.ca.gov/wp-admin/admin-post.php">` with fields:

| field | example value |
|---|---|
| `action` | `abclqs_daily_report` |
| `url` | `/licensing/licensing-reports/new-applications/` (the referring page) |
| `rpttype` | `2` (new-applications; status-changes presumably uses a different code, not confirmed — see below) |
| `abclqs_daily_report` | a WP nonce, e.g. `3d645357b1` |
| `abclqs-date` | user-entered date, `MM/DD/YYYY` |
| `_wp_http_referer` | the referring page path |

**This is the mechanism a browser uses to pick an arbitrary report date.** It is the
one and only reverse-engineered piece worth handing to Phase 1, so the full finding
is recorded here even though the shipped scraper does not use it (why, below).

Two independent blockers, found in this order:

1. **robots.txt.** `Disallow: /wp-admin/` with a single carve-out,
   `Allow: /wp-admin/admin-ajax.php`. The form POSTs to `admin-post.php`, a
   *different* file under `/wp-admin/` that the carve-out does not mention — so it
   stays disallowed. (The task brief anticipated an `admin-ajax.php` action; the
   real plugin uses `admin-post.php` instead, and JS-searching the enqueued
   `daily-report-form.js` confirms there is no `fetch()`/`$.ajax()` call anywhere —
   it's a plain HTML form submit, not an AJAX call at all, despite the script's
   `abclqs-daily-report-js` handle name.) The scraper never POSTs here; it stops at
   "disallowed" per PLAN.md's politeness constraint, exactly as instructed.
2. **Even the POST's own redirect target doesn't work for a plain client.**
   Out-of-band curl probing (POST with a freshly-scraped nonce, since anonymous WP
   nonces are time-windowed rather than session-bound, so this worked without any
   cookies) got a real `302 Found` with
   `Location: /licensing/licensing-reports/new-applications/?RPTTYPE=2&RPTDATE=08/01/2026`
   — i.e., the site's *intended* answer to "how do I ask for a specific date" is a
   plain GET with query params. But requesting that URL directly — with or without
   the query string URL-encoded, with or without cookies/Referer carried over from
   the POST, with a fully browser-shaped header set — always comes back
   `301 Moved Permanently` to the bare URL (`http://www.abc.ca.gov/...` — note the
   scheme downgrade to `http`, itself a symptom of an edge rule rather than normal
   WordPress canonicalization), **with the query string stripped**. This is not
   specific to `RPTTYPE`/`RPTDATE`: `?foo=bar` on the same path gets the identical
   treatment, and so does a query string on the completely unrelated
   `/licensing/license-lookup/single-license/` page and even the bare homepage.
   Read as a Cloudflare-edge anti-bot rule (no `cf_clearance` token = no query
   strings survive), not a robots.txt matter and not something `politeFetch`'s
   plain-GET model can pass — doing so would mean impersonating a full
   JS-executing browser, out of scope here.

**Net effect: there is no GET-only, robots-compliant way to select an arbitrary
report date, and no GET-only way to load the per-license detail page either**
(same query-string block — see "Per-license URL pattern" below). The one thing that
*does* work, cleanly, is fetching a report page with **no** query string at all: it
server-renders a full `<table id="license_report">` for whatever date the site
currently treats as "current" (empirically the most recent business day — e.g. a
fetch made Tuesday 2026-08-11 returned "Report Date: Monday, August 10, 2026" on
both report pages, same date on both, suggesting one shared "current report date"
concept across report types rather than per-report-type staleness). That bare-URL
GET is what the shipped scraper uses, for both `new-applications` and
`status-changes` (the task's "if the same mechanism trivially covers it too"
condition was met — it's the identical code path, just a different URL and a
different column layout).

## Response format

Server-rendered **HTML**, not JSON/CSV, despite the page enqueuing DataTables with
CSV/PDF export buttons (`license-report.js` — those buttons export whatever's
already in the DOM client-side; there's no separate JSON/CSV backend endpoint, and
none was needed since the DOM already carries every column DataTables would
export, including the hidden ones — see next section).

## Open question 5 — is premises city a clean filterable field?

**Yes.** Both report tables' `<thead>` declare 19 (new-applications) or 20
(status-changes) columns, several marked `visible="0"` in the DataTables config —
meaning DataTables hides them from the on-screen widget, but they are fully present
in the raw HTML/DOM, which is what cheerio reads. Column set includes `Prem Street`,
**`City`**, `County`, `Zip Code`, plus mirrored `Mailing *` columns. `City` is a
plain uppercase city name per row (`"CHINO"`, `"CHINO HILLS"`, `"WINDSOR"`,
`"LOS ANGELES"`, ...) — an exact-match string field, not an address blob requiring
regex/geocoding. The scraper filters with `TARGET_CITIES = new Set(['CHINO',
'CHINO HILLS'])` against `city.trim().toUpperCase()`; since both are distinct exact
values in the same column, there is no substring-overlap risk between them (the
task's explicit worry — "Chino" matching inside "Chino Hills" — doesn't arise
because we never substring-match address text).

A `County` hidden column also exists but is a **numeric ABC-internal code**
(San Bernardino premises observed as `"36"`), not a name — not decoded for this POC
since `City` alone answers the filtering need.

## Per-license URL pattern verdict

The pattern is real and appears as the `href` on every license-number cell:

```
https://www.abc.ca.gov/licensing/license-lookup/single-license/?RPTTYPE=12&LICENSE=<number>
```

**It does not resolve for a plain client** — same site-wide query-string-stripping
redirect described above. Verified directly against a real license number found in
this run (`661231`, and again against `663555`): `curl` gets `301` to the bare
`single-license/` page (no license content) every time, including a test that
first loaded the report page (to get a fresh `__cf_bm` cookie) and then requested
the detail URL with that cookie plus a matching `Referer` header — i.e., replaying
exactly what a real browser click would send. Still stripped.

Per the task's own fallback instruction, every item's `source_url` is the **daily
report page URL** instead (`.../new-applications/` or `.../status-changes/`), and
the intended per-license URL is preserved unused in `meta.attempted_detail_url` on
every item, for Phase 1 to revisit if a different fetch strategy for this one host
is ever justified.

**Caveat worth flagging loudly for Phase 1 (provenance implications):** because the
report pages have no date parameter, `source_url` for an item stored today will,
by next business day, show a *different* day's report — the link a reader clicks
will no longer display the data that justified the claim. The permanent record
lives in `documents.raw_path` (the exact HTML snapshot, content-hashed, archived
under `data/raw/`) and in `items.meta`, not in the live URL. This is a real gap
against PLAN.md's "every published claim links to a primary source" constraint as
currently written; Phase 1 either needs to accept "cite the archived snapshot,
not a live page" for this one source, or solve the query-string block some other
way (e.g. an authenticated/JS-capable fetch path, if ever worth the engineering
cost for one source).

## Days walked back to find a Chino/Chino Hills event

**Zero — not by choice.** The "walk back day by day, max 14 days" mechanism from
the task brief assumes date selection works; it doesn't (see above), so there is
nothing to walk back *through*. The scraper takes whatever single date the site
currently defaults to, once, and that is the only day it will ever see in a given
run. On this run (`2026-08-10`'s report, fetched 2026-08-11):

- `new-applications`: 20 statewide rows, **0** Chino/Chino Hills matches.
- `status-changes`: 96 statewide rows, **2** Chino/Chino Hills matches — the
  acceptance-satisfying data. Both rows are one linked story at the same premises
  (13115 Central Ave, Chino, CA 91710): license `663555` (RZK Liquor / Nadeen A.
  Rzk) going `ACTIVE → CANCEL`, cross-referenced via the `Transfer-From/To` column
  to license `679548` (Nazih Ahmad Khaddour) going `PEND → ACTIVE` — i.e., a live
  liquor-license ownership transfer at one Chino storefront, dated by
  `original_issue_date` `2026-08-07`, four days before this scrape. Exactly the
  kind of item this source exists to catch.

If that default day had turned up zero Chino/Chino Hills rows in *either* report
(plausible on a quiet day, given how sparse `new-applications` was), this scraper
would legitimately store zero items on that run and there would be no fallback —
a real limitation, documented in `ctx.note()` in-code as well as here.

## Failure modes

- **No day-walk-back at all** (root cause above) — the single biggest limitation.
  A production cadence (daily cron) would accumulate history day-by-day going
  forward, but can never backfill and will silently show nothing on any day the
  default report happens to have no Chino/Chino Hills rows (see empty-report
  behavior below — it degrades gracefully, not an error).
- **Weekends/holidays:** not directly observed (this run happened to land on a
  Monday's report), but the from-scratch discovery form's own client-side
  validator (`daily-report-form.js`) enforces "select a date that is 2 or more
  days past," implying the site does not consider very recent days final/available
  — consistent with the "most recent *business* day" read of the default. Expect
  the effective report date to occasionally sit 3+ calendar days behind the fetch
  date across a weekend or holiday, though this wasn't directly measured.
- **Empty reports:** handled gracefully — `matched === 0` is a normal, logged
  outcome (`ctx.note()`), not an error; `new-applications` hit exactly this case
  on this run (0 of 20 statewide rows were Chino/Chino Hills) and the scraper
  completed normally with `itemsNew: 0` from that report.
- **Column-layout drift:** the parser builds a header-name → column-index map per
  fetch (`headerIndex()`) rather than hardcoding positions, so a reordered column
  degrades gracefully; a *renamed* or removed column degrades less gracefully
  (the lookup returns `undefined` and the field comes back empty rather than
  throwing) — acceptable for POC, worth a stronger assertion in Phase 1.
- **ETag/conditional GET:** both report URLs support it in practice — the second
  `run-one.ts` execution reused cached bodies (`documentsFetched: 2,
  documentsNew: 0`) via the existing content-hash dedup in `insertDocument`
  (`ctx.fetchDocument` didn't need an actual 304 from the origin for this, since
  the hash-based dedup in `db.insertDocument` catches identical bytes even on a
  fresh 200 — origin-level `ETag`/`If-None-Match` behavior itself wasn't
  separately isolated in this run).
- **Rate limiting:** during out-of-band `curl` probing (outside the polite
  fetcher, deliberately rapid to map the query-string-block behavior), the origin
  returned Cloudflare `521`/`522` errors briefly under heavy rapid-fire request
  volume, then recovered on its own within ~30s once probing backed off. The
  shipped scraper only ever makes 2 requests per run (one per report page) at the
  fetcher's normal 2s/host pacing, well under whatever threshold that was.

## Verification performed

- `npx tsc --noEmit`: clean.
- `node src/run-one.ts abc-licenses` run twice: first run
  `{"documentsFetched":2,"documentsNew":2,"itemsSeen":2,"itemsNew":2}`; second run
  `{"documentsFetched":2,"documentsNew":0,"itemsSeen":2,"itemsNew":0}` — idempotent.
- Spot-checked both stored `source_url`s (both point at
  `https://www.abc.ca.gov/licensing/licensing-reports/status-changes/`, since both
  stored items came from that report) with `curl`: the live page body contains
  both license numbers (`663555`, `679548`) and both names (`RZK`, `KHADDOUR`) —
  content-verified, not just a `200`.
- Spot-checked the (unused, documented-as-broken) per-license `attempted_detail_url`
  for license `663555` with `curl`: confirmed `301` to a contentless bare page,
  consistent with the verdict above.
