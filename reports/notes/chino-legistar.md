# Task 0.1 — Chino Legistar scraper

Scraper: `src/scrapers/chino-legistar.ts`. Method: `api` (Granicus Legistar Web
API), plus a small amount of HTML parsing (cheerio, already a project
dependency) needed to work around a real permalink bug described below.

## Open question 1 (PLAN.md): Legistar API enabled for Chino? — YES, definitively

`https://webapi.legistar.com/v1/chino/*` is live, unauthenticated, and returns
real data. No ViewState scraping needed for listing/detail data. Confirmed
endpoints and exact query patterns used (copy-pasteable):

```http
GET https://webapi.legistar.com/v1/chino/events?%24top=30&%24orderby=EventDate%20desc
GET https://webapi.legistar.com/v1/chino/events/<EventId>/eventitems?AgendaNote=1&MinutesNote=1
GET https://webapi.legistar.com/v1/chino/eventitems/<EventItemId>/votes
GET https://webapi.legistar.com/v1/chino/matters?%24top=5          (probed only, not ingested)
GET https://webapi.legistar.com/v1/chino/matters/<MatterId>        (probed only, not ingested)
```

`$top`/`$orderby` are OData query params (URL-encode `$` as `%24`). No API
key/auth required. Response is plain JSON.

## Fetch method that worked

1. Fetch `events?$top=30&$orderby=EventDate desc` to get a recent window.
2. Walk candidate City Council events (past, `EventAgendaStatusName` in
   `Final`/`Final Revised`, `EventComment` not containing "Cancelled") newest
   first, fetching `eventitems` for each until one has `items.length > 0`.
   This was necessary in practice (see below) — the single most-recent
   candidate did not work.
3. For the selected meeting (and up to 2 other bodies, Planning Commission
   prioritized), fetch `eventitems`, the meeting's own `MeetingDetail.aspx`
   HTML (for permalink recovery, see below), and the `EventAgendaFile` PDF if
   present.
4. Sample votes for a mix of consent-bloc and individually-moved voted items.

Run 1 (clean): `documentsFetched: 10, documentsNew: 10, itemsSeen: 134,
itemsNew: 134`. Run 2 (immediately after, no data changed): `documentsFetched:
10, documentsNew: 3, itemsNew: 0`. Items are fully idempotent; see "HTTP
behaviors" below for why 3 HTML documents don't dedupe to 0.

Target meeting: **City Council, EventId 1963, 2026-07-21**, 66 event items, 28
of them carrying a Matter (agenda-actionable items; the rest are
CALL TO ORDER/ADJOURN/roll-call-summary/signature-block filler rows). Also
ingested: **Planning Commission EventId 1971 (2026-07-15)**, 24 items, and
**Infrastructure/Streets Committee EventId 2022 (2026-07-28)**, 14 items.
Final counts: 104 `agenda_item` rows, 30 `vote` rows across 12 `agenda`-typed
documents + 1 `listing` document.

## Agenda-status semantics discovered (important, not obvious from field names)

`EventAgendaStatusName` values seen: `Hidden`, `Final`, `Final Revised`.
`Hidden` = agenda not yet published (future meeting, no agenda posted yet).
`Final`/`Final Revised` = published. **But agenda status alone is not
sufficient to predict a usable meeting**: `EventId 1981` (City Council,
2026-08-04, the most recent *chronologically* past Council meeting at scrape
time) had `EventAgendaStatusName: "Final"` and 0 event items, because
`EventComment: "Regular Meeting (Cancelled)"`. The scraper checks
`EventComment` for "Cancelled" and, as a second line of defense, actually
fetches `eventitems` and moves to the next candidate if it comes back empty,
rather than trusting agenda status as a proxy for "meeting happened." Any
production version must do the same — do not gate on `EventAgendaStatusName`
alone.

`EventMinutesStatusName` stayed `Draft` even for the target meeting
(`Final` agenda). This is normal: Chino approves minutes at the *next*
Council meeting, so a meeting's own minutes are `Draft` until then. Don't
treat `Draft` minutes as a data problem.

## Permalink bug (the most important finding of this task)

PLAN.md assumed item permalinks follow
`https://chino.legistar.com/LegislationDetail.aspx?ID=<MatterId>&GUID=<MatterGuid>`
using the Web API's `EventItemMatterId`/`EventItemMatterGuid`. **This is
wrong for Chino's tenant.** Verified by hand:

- API: `MatterId 3237`, `MatterGuid 5249FF1A-737B-4EB3-B97E-B12FA418E9FE` for
  File #26-406 ("Chino Community Garden's 10th Anniversary").
- Requesting `https://chino.legistar.com/LegislationDetail.aspx?ID=3237&GUID=5249FF1A-...`
  returns **HTTP 200** with body `Invalid parameters!` (19 bytes) — a
  "successful" response that is actually broken. Adding `&G=<client-guid>`
  or `&Options=&Search=` does not fix it.
- The *real*, working link for the same matter, as rendered in
  `chino.legistar.com/MeetingDetail.aspx?LEGID=1963&GID=931&G=...`'s own
  HTML, is `LegislationDetail.aspx?ID=8140820&GUID=C1C6DF18-C67A-4975-AFA0-417CE1EBA61C&G=...`
  — a completely different ID and GUID for the same matter, confirmed by the
  resulting page's `<title>Chino - File #: 26-406</title>`.

So the Web API's Matter records and the InSite website's LegislationDetail
records live in different ID spaces for this tenant (or at least aren't
directly convertible), even though `MatterFile` ("26-406") is shared between
them. **Fix implemented:** the scraper fetches each meeting's own
`MeetingDetail.aspx` (already have the URL as `EventInSiteURL`), parses it
with cheerio, and reads real `ID`/`GUID` pairs off `a[id*="hypFile"]` anchors
inside the Telerik RadGrid, keyed by the File # text (`MatterFile`). This
recovered working permalinks for **28/28** matter-bearing items in the target
meeting (100%). Items without a `MatterFile` (procedural rows — CALL TO
ORDER, ADJOURN, signature block, etc.) fall back to the meeting's
`EventInSiteURL`, which is always non-empty and always resolves.

Spot-checked (curl, 3 random source_urls from the final DB state):

- `https://chino.legistar.com/LegislationDetail.aspx?ID=8140825&GUID=5D2A308B-4EFD-4EFB-B139-1ADB47BF95D2&G=FCED2B78-20F3-40ED-B45D-72741543B315&Options=&Search=` → **HTTP 200**, 102,318 bytes, `<title>Chino - File #: 26-415</title>` (R.J. Noble pavement contract — a `vote` item's source_url).
- Same URL again for a second sampled `agenda_item` row (random draw happened to repeat) → same **HTTP 200**, confirmed real.
- `https://chino.legistar.com/MeetingDetail.aspx?LEGID=1963&GID=931&G=FCED2B78-20F3-40ED-B45D-72741543B315` → **HTTP 200**, 201,827 bytes (meeting-level fallback URL used by procedural items).

If this fix had not been made, roughly 76% of items (the matter-bearing
majority) would have shipped with broken "Invalid parameters!" source_urls —
a silent provenance failure that HTTP-200 monitoring would not catch.
**Any other scraper on this codebase that constructs Legistar permalinks from
API MatterId/MatterGuid alone should be checked against this finding.**

## Votes: published, but the votes endpoint has its own data-integrity bug

Chino **does** publish per-council-member roll-call votes via
`eventitems/<id>/votes`. But: for an `EventItemId` that was decided as part
of an omnibus/consent-calendar motion (no distinct roll-call of its own — the
common case; e.g. "Motion ... to approve the Consent Calendar items 1-6,
8-11, and 13-16" recorded under one separate "host" EventItemId), the votes
endpoint does **not** return 404 or `[]`. It silently returns the votes
belonging to a **different** EventItemId (the motion's real host item),
unchanged, with HTTP 200. Verified: requesting votes for consent-bloc items
54363, 54391, 54392 (three different IDs) all returned the *same* vote
records, all stamped `VoteEventItemId: 54969` (the actual "approved the
Consent Agenda" item) — not the IDs requested. Requesting votes for
individually-moved items (their own distinct motion/second, e.g. items 17-21
on the target agenda) correctly returned self-consistent
`VoteEventItemId === requested id`.

**Mitigation implemented:** before storing any vote record, the scraper
checks `VoteEventItemId === requested EventItemId` for every vote in the
response; a mismatch is discarded, not stored (would otherwise misattribute
one item's votes to another). This run: probed 8/22 voted items in the target
meeting (grouped by mover/seconder pair to sample both the consent bloc and
individually-moved items), 6 self-consistent (30 vote records stored), 2
mismatched (correctly discarded). 30 `vote` items are in the DB with real
council-member names and AYES/NOES values.

## HTTP behaviors

- **No ETag/Last-Modified anywhere** on `webapi.legistar.com` responses
  (checked response headers directly). Idempotent re-runs rely entirely on
  the infra's content-hash dedup (`documents.content_hash`), not conditional
  GET — confirmed: run 2 reports `itemsNew: 0` for all 134 items.
- **`chino.legistar.com/MeetingDetail.aspx` is NOT byte-stable** across
  identical requests. It's ASP.NET WebForms + Telerik RadGrid; every render
  embeds a fresh `__VIEWSTATE`/`__EVENTVALIDATION` and `WebResource.axd`
  cache-busting timestamps (`&t=...`), so its `content_hash` differs on every
  fetch even though the visible agenda content is identical (confirmed by
  diffing two consecutive fetches — only framework plumbing differed).
  Practical effect: this doc type will keep creating new `documents` rows on
  every run (`documentsNew: 3` on run 2, matching the 3 meetings ingested),
  unlike the plain-JSON API docs and the PDF, which dedupe to 0 cleanly.
  Storage growth from this is bounded (a few hundred KB per meeting per run)
  but real; a production scheduler running this hourly would want to either
  accept it or strip the dynamic tokens before hashing (out of scope here —
  that logic lives in `src/context.ts`/`src/store.ts`, which this task does
  not own).
- **robots.txt**: `webapi.legistar.com` and `chino.legistar.com` both return
  HTTP 404 for `/robots.txt` (no file present) — the shared fetcher fails
  open in that case, so no `skipRobots` flag is needed for either host.
  `chino.legistar1.com` (the separate host serving agenda PDFs, referenced by
  `EventAgendaFile`) **does** have a robots.txt: `User-agent: * / Disallow:
  /`. Read as generic search-crawler avoidance on a static file server, not a
  restriction on fetching a specific public document whose URL came from the
  official Web API — same reasoning `nws-alerts.ts` uses for
  `api.weather.gov`. `skipRobots: true` is used only for those PDF fetches,
  noted via `ctx.note()`.
- RSS fallback (`chino.legistar.com/Feed.ashx?M=Calendar`) exists and returns
  HTTP 200 — probed once via `fetchRaw`, not ingested, since the Web API is
  strictly richer (structured items, votes, matter linkage) than an RSS feed
  would be. Kept as a documented fallback path only.

## Open question 2 (PLAN.md): where do Planning Commission agendas live?

**Answered for the Legistar side: Planning Commission holds real meetings in
Legistar.** `EventBodyName: "Planning Commission"` appears in the recent
events window with non-cancelled, published-agenda meetings (e.g. EventId
1971, 2026-07-15, 24 real event items, ingested this run with a working
`MeetingDetail.aspx` HTML and per-item permalinks resolved the same way as
Council). This does not rule out Planning Commission *also* appearing in the
CivicPlus Agenda Center (Task 0.2's job to check) — but it is not exclusive
to it.

## Data quality notes / failure modes

- **Test data confirmed in `/matters`**: `MatterFile "22-071"`, `MatterName
  "sample memo"`, `MatterTitle "TEST 1"`, `MatterBodyName "Planning
  Commission"`. This scraper never queries `/matters` for item derivation
  (only for this one documentation probe) — it walks `events`/`eventitems`
  for real meetings, so this placeholder data does not appear in stored
  items unless a real agenda item happens to link a test matter as its
  `EventItemMatterId`. Not observed in the meetings ingested this run, but
  a production pipeline should filter `MatterTitle`/`MatterName` values that
  look like placeholders before trusting them in synthesis.
- **Null `EventItemTitle`**: 3 of 66 target-meeting items have a null title —
  these are roll-call "motion summary" rows (e.g. the Consent Calendar
  approval motion itself, `EventItemActionName: "approved the Consent
  Agenda"`). `EventItemActionText` carries the real content
  ("Motion by Council Member Lucio, seconded by ... The motion carried by
  the following vote:") but the title field itself is empty. Stored as-is
  (title: null) per the literal field mapping; `body`/`meta.actionText`
  carry the substance.
- **Minutes/agenda notes are RTF, not plain text.** `EventItemMinutesNote`
  (and occasionally `AgendaNote`) arrive as full RTF documents (font table,
  color table, `\par` runs). Wrote a small brace-depth-aware RTF→plaintext
  stripper (not a general RTF parser — good enough for Chino's simple
  single-run notes; verified against real samples, e.g. correctly extracts
  "Mayor Ulloa presented the Mayor's Home Beautification Award for July 2026
  to Mary Jane and Benjamin Sotelo..." from the raw RTF). Handles `\par`/
  `\line`/`\tab`, `\'XX` hex escapes, `\uNNNN` unicode escapes, and skips
  ignorable destination groups (`fonttbl`, `colortbl`, etc.) by brace depth.
- **Procedural filler items** (CALL TO ORDER, CONSENT CALENDAR header,
  ADJOURN, roll-call attendance block, clerk's certification/signature
  block) have no `MatterFile` and correctly fall back to the meeting-level
  `EventInSiteURL` — appropriate, since there is no deeper real page for
  them to link to.
- Event dates from the API have no time-of-day (`"2026-07-21T00:00:00"`,
  midnight local); `EventTime` is a separate string field (`"6:00 PM"`) not
  currently folded into `occurred_at`. `occurred_at` is therefore
  date-precision only, which is consistent with how PLAN.md's schema
  describes `occurred_at` (no stated requirement for time-of-day precision).

## Politeness / run time

Single run: ~24–35s wall time, well under the ~3 minute budget. Request count
this run: 1 events-list + 3 eventitems (1 cancelled-meeting probe + 2 kept) +
3 MeetingDetail HTML (permalink recovery) + 1 agenda PDF + 1 matters probe +
1 Feed.ashx probe + 8 votes probes ≈ 18 requests, all through the shared
`politeFetch` 2s/host delay.

## Prior-art used

None applicable — a separate agent (research-prior-art) is doing the Task 0.0
prior-art reading pass; this task was run directly against the confirmed-live
API without needing `opencivicdata/python-legistar-scraper` or
`cdp-scrapers` reference material. Worth a follow-up cross-check once that
research lands: their `get_legistar_events_for_timespan` (`cdp-scrapers`)
shape may validate/improve the votes/eventitems meta shape used here, and
either project's HTML fallback code may already document the
MatterId-vs-InSite-ID mismatch found above, which would be a useful sanity
check.

## Verification performed

- `npx tsc --noEmit`: clean.
- `node src/run-one.ts chino-legistar` run twice from a clean slate (deleted
  only this source's rows first): run 1 `itemsNew: 134`, run 2 `itemsNew: 0`.
  `documentsNew` goes 10 → 3 on the repeat (see HTML-instability finding
  above for why it isn't 0).
- 3 source_urls spot-checked with `curl` against the live site: all HTTP 200
  with real, matching content (not the "Invalid parameters!" error page).

## Not finished / left for a later phase

- PDF agenda text extraction (pdf-parse) — out of scope per the task brief
  ("Don't parse the PDF — the API gives structure"); the PDF is archived
  raw only.
- No attempt to fold `EventTime` into `occurred_at` as a full timestamp.
- No filtering of test/placeholder matters — noted as a risk, not fixed,
  since it wasn't observed in the actual ingested items this run.
- Only 2 non-Council bodies probed per run (Planning Commission +
  Infrastructure/Streets Committee), per the "1-2 other recent meetings"
  scope in the task brief — Economic Development, Legislative Policy,
  Housing, Investment Advisory, and CSPR Commission bodies exist in the
  window but weren't ingested (their `EventBodyName` values are recorded in
  the notes, which is sufficient for the POC's "does this body meet in
  Legistar" question).
