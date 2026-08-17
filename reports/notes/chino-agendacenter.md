# Task 0.2 — Chino Agenda Center (commissions)

Scraper: `src/scrapers/chino-agendacenter.ts` (key `chino-agendacenter`). Site:
`cityofchino.org/agendacenter`, CivicPlus/CivicEngage Agenda Center module
(ModID=65). Research + implementation date: 2026-08-11.

## Planning Commission verdict (open question 2)

**Planning Commission does not publish through the CivicEngage Agenda Center at
all — it lives exclusively in Legistar.**

## Discovery pattern that worked

`GET /agendacenter` (plain HTML, not blocked by robots.txt) renders the Agenda
Center's category picker and the currently-selected year's table server-side —
no separate JSON/AJAX call is needed to get ground truth. Two things were tried
and abandoned first:

1. **`/Search/?...` (civic-scraper's CivicPlus pattern)** — `biglocalnews/
   civic-scraper`'s CivicPlus module (see `reports/notes/prior-art.md`) POSTs to
   a server-rendered `/Search/?term=&CIDs=all&startDate=...` endpoint that
   returns every category for a date range in one page. **cityofchino.org's
   `robots.txt` disallows `/Search` and `/Search.aspx` outright.** Under
   PLAN.md's politeness constraint (respect robots.txt; `skipRobots` reserved
   for documented public APIs) this path is not available here — a real,
   site-specific constraint the prior-art repo didn't anticipate (it spoofs a
   desktop Chrome UA rather than checking robots.txt at all).
2. **RSS** — the sibling `chino-news-rss.ts` catalog
   (`reports/notes/chino-news-rss.md`) lists exactly two feeds under Agenda
   Center (ModID=65): `CID=All-0` and `CID=Community-Services-Commission-2`.
   Both were fetched live and **both return zero `<item>` elements**
   (`<channel>` metadata only). CivicPlus's Agenda Center RSS appears to only
   surface *recent* activity, and this Agenda Center has none — see "Volume"
   below. RSS is not a usable discovery or ingestion path here, in contrast to
   Task 0.3's Newsflash/Calendar feeds, which worked fine on the same platform.

What actually worked: parse the rendered `/agendacenter` HTML directly with
cheerio.

- **Category enumeration** — ground truth is the category-picker checkbox
  list: `<input name="chkCategoryID" value="{catID}">` paired with
  `<label for="{catID}">{Commission Name}</label>`. This list is the site's own
  authoritative "which bodies publish here" — it renders every category that
  has *ever* had content (the same page's "View More" year links go back to
  2017 for the one category present), not just categories with current-year
  data.
- **Per-category listing** — each category renders as
  `<div id="cat{ID}"><span id="section{ID}">...<table>` containing the
  currently-selected ("current") year's rows inline in the initial page load.
  Row structure: `<tr class="catAgendaRow">` with an `Agenda` `<td>`, a
  `Minutes` `<td>` (empty if no minutes posted), and a `Download` `<td>`.
- **Date quirk, ported directly from civic-scraper's CivicPlus module**
  (credited in `reports/notes/prior-art.md`): the reliable meeting date is
  *not* the visible "Jan 4, 2022" cell text — it's embedded in the file link's
  `name`/`id` attribute as `_MMDDYYYY-<rowid>`, e.g.
  `<a id="_01042022-8" name="_01042022-8">`. Parsed with
  `/^_?(\d{2})(\d{2})(\d{4})/` → ISO `yyyy-mm-dd`. This is `parseAnchorDate()`
  in the scraper.
- **PDF URL pattern**: `/AgendaCenter/ViewFile/Agenda/_MMDDYYYY-<id>` — matches
  PLAN.md's assumed pattern exactly. `ViewFile/Minutes/...` is the sibling
  pattern for minutes (present in the HTML as a taxonomy but empty for the one
  document found — see "Minutes" below).

## Bodies enumerated

**Exactly one: "Community Services Commission" (catID=2).** No Planning
Commission, no other board/commission appears anywhere in the category picker.
This matches the independent sibling finding in `chino-news-rss.md`'s
Agenda Center RSS catalog line-for-line (same two CIDs: `All-0` and
`Community-Services-Commission-2`) — two independent extraction methods (live
HTML category picker vs. hand-enumerated RSS catalog) agree exactly.

## Planning Commission verdict — evidence

- **Agenda Center side (this scraper):** the `/agendacenter` category checkbox
  list — the page's own authoritative enumeration of every body that has ever
  posted here, going back to 2017 per the "View More" year links — contains
  no Planning Commission entry, only Community Services Commission.
- **Cross-check:** `reports/notes/chino-news-rss.md`'s independently
  hand-enumerated `RSS.aspx` catalog lists Agenda Center (ModID=65) as having
  only two feeds, `All` and `Community Services Commission` — no Planning
  Commission feed exists on this platform either.
- **Legistar side:** `reports/notes/chino-legistar.md` (open question 2
  section) found Planning Commission holding live, recent meetings in
  Legistar — `EventBodyName: "Planning Commission"`, EventId 1971, meeting
  date 2026-07-15, 24 agenda items.
- **Conclusion:** Planning Commission's agendas are not merely *also* posted
  here — they are entirely absent from the CivicEngage Agenda Center. Every
  Planning Commission agenda a reader could find on `cityofchino.org` comes
  through Legistar (`chino.legistar.com`), not `/agendacenter`.

## Volume — the CivicEngage Agenda Center is effectively dormant

The task brief assumed "ingest the 2-3 most recent agenda PDFs across the
commissions found." Discovery found **exactly one agenda PDF in the entire
Agenda Center, site-wide, across all categories and all years**: Community
Services Commission's January 4, 2022 meeting. The category's own "current
year" tab (the site's own signal for "most recent year with data") is 2022;
the year list (2022, 2021, 2020, 2019, 2018, 2017) has no gap-filling entries
for 2023–2026, meaning nothing has been posted here in **over 4.5 years** as of
this run (2026-08-11). This is consistent with, and explains, the RSS feeds
returning zero items (see above) — RSS surfaces only recent activity, and
there is none to surface. The scraper ingests the one PDF that exists and
notes the shortfall explicitly via `ctx.note()` rather than padding the count.

Working theory (not independently verified beyond the two data points above):
Chino appears to have migrated *all* commission/board agenda publishing to
Legistar at some point after January 2022, leaving the CivicEngage Agenda
Center as an orphaned historical archive for Community Services Commission
only. That would also explain why Planning Commission never appears here at
all rather than "used to, then stopped."

## What was ingested

- 1 document (`doc_type: 'agenda'`), the Community Services Commission
  January 4, 2022 PDF, fetched via `ctx.fetchDocument` (`docType: 'agenda'`,
  `meetingDate: '2022-01-04'`).
- 1 item (`item_type: 'agenda_item'`), `external_id: '2022-01-04-1'`,
  `occurred_at: '2022-01-04'`, `meta: {agendaNumber: '1', body: 'Community
  Services Commission'}`, `source_url` = the PDF URL with `#page=2` (see PDF
  extraction quality below — page number is tracked, not guessed).

## PDF extraction quality

`extractPdfText` (the shared `src/pdf.ts` wrapper) handled the PDF cleanly:
**138 pages, 165,153 characters, clean selectable text** — not scanned/
image-only, no OCR artifacts observed. Notably the file linked from
"Agenda" is actually a full **agenda packet** (`Content-Disposition:
inline;filename="20220104 - Agenda Packet (PDF).pdf"`, 7.1 MB): a 1-page
notice + 1-page agenda followed by ~136 pages of staff report and attachment
material (a Parks & Facilities Master Plan document). CivicPlus doesn't
distinguish "agenda" from "agenda packet" in this listing's link taxonomy the
way civic-scraper's `packet=true` query-param convention does elsewhere
(see prior-art.md) — here the plain `ViewFile/Agenda/...` link *is* the
packet.

**Item-splitting heuristic** (POC quality, `splitAgendaItems()`):

1. Find the standalone `AGENDA` heading line.
2. Find the next `ADJOURN`/`ADJOURNMENT` line after it — this reliably brackets
   the actual agenda text and excludes everything after it (staff reports,
   attachments, which are full of their own numbered lists that would
   otherwise false-positive as agenda items — e.g. this PDF's staff memo
   contains an unrelated "1. ... 2. ... 3. ..." scope-of-work list on page 3
   that the ADJOURN boundary correctly excludes).
3. Within that bracketed region, split on lines matching `/^\s*(\d{1,2})\.\s+/m`.
4. Falls back to an 8,000-character cap from the AGENDA heading if no ADJOURN
   line is found (not triggered on this document; logged via `ctx.note()` if
   it ever fires).

Result on the one real document: exactly **1 agenda item** extracted ("1.
Parks and Facilities Master Plan Final Update...", correctly excluding the
~136 pages of packet material that follow). This is a joint special meeting
(City Council + Community Services Commission) with a single agenda item, so
one item is the *correct* answer for this document, not evidence of
under-splitting — the heuristic hasn't been exercised against a multi-item
regular-meeting agenda because none exists in this Agenda Center currently.
**Known limitations, not exercised here:** no handling for lettered
sub-items, roman-numeral items, or agendas without an explicit ADJOURN line
(untested fallback path).

**Page tracking**: `extractPdfText`'s output embeds `-- N of TOTAL --` page-
break markers between pages. The splitter counts markers preceding an item's
start offset to compute its real page number, so `source_url` carries a
genuine `#page=N` fragment (`#page=2` for the one item — verified against the
PDF: the agenda text after "AGENDA" begins on the page headed "JANUARY 4,
2022  2"), not a placeholder.

## Date parseability

100% for the one document present: the `_MMDDYYYY-<id>` anchor-name pattern
parsed cleanly to `2022-01-04`. No malformed or missing date anchors observed
(small sample size caveat: n=1).

## Minutes

Checked, not ingested (per task scope). Zero `/AgendaCenter/ViewFile/Minutes/`
links anywhere on the listing page; the one Agenda row's "Minutes" table cell
is empty. No minutes have ever been posted for this Agenda Center's one
tracked meeting.

## HTTP behaviors

- `/agendacenter` (HTML): `200`, `cache-control: private, s-maxage=600,
  no-transform`, no `ETag`/`Last-Modified` — same non-cacheable pattern the
  sibling scraper found on `RSSFeed.aspx`.
- `/AgendaCenter/ViewFile/Agenda/_01042022-8` (PDF): `200`,
  `content-type: application/pdf`, `content-disposition: inline;filename="...
  Agenda Packet (PDF).pdf"`, no `ETag`/`Last-Modified` either — but since the
  PDF's *bytes* are static (unlike the RSS feeds' live `<lastBuildDate>`),
  the shared `fetchDocument`'s content-hash dedup naturally makes re-fetches
  a no-op (`documentsNew: 0` on run 2) without needing the sibling's
  `resolveDocumentId` workaround — that workaround is specifically for
  sources whose *document bytes* churn every request; this source's bytes
  don't.
- No WAF/bot-blocking, no CAPTCHA, no 403s for the honest
  `ChinoValleyTodayBot/0.1` UA at the enforced 2s/host delay — consistent with
  the sibling scraper's finding on the same platform.
- `robots.txt` disallows `/Search`, `/Search.aspx`, `/RSS.aspx`, and several
  admin/utility paths; `/agendacenter`, `/AgendaCenter/ViewFile/*`, and
  `/RSSFeed.aspx` are all unrestricted.

## Failure modes / known limitations

- **The Agenda Center has essentially no current data.** One PDF, one item,
  last updated January 2022. The scraper's `MAX_PDFS = 3` bound and
  multi-category-aggregation logic are written generically (to behave
  correctly if more categories/PDFs existed) but are functionally untested
  against real multi-document, multi-category input — there is no such input
  on this site to test against. If Chino Hills' Agenda Center (Task 0.4, same
  platform) has more current activity, the sibling scraper there is a better
  stress test of this same code shape.
- **Item-splitting heuristic is validated on n=1 document.** The
  ADJOURN-boundary approach worked cleanly here specifically because it
  excluded a false-positive numbered list in the packet attachments — real
  evidence the boundary matters — but a regular (non-joint, non-special)
  meeting agenda with multiple numbered items and standard section headers
  (Consent Calendar, Public Hearings, etc.) has not been tested.
- **Category discovery depends on the initially-rendered HTML**, i.e. only
  whichever year a category's `<select>`/tab defaults to. If a category ever
  has multiple *categories* each defaulting to different years with newer
  PDFs in a non-default year, this scraper would miss them (would need the
  `AgendaCenter/UpdateCategoryList?year=&catID=` AJAX endpoint, which returns
  full page navigation rather than a partial fragment under plain `curl`/GET
  without the site's expected `X-Requested-With` XHR header — not pursued
  further since it wasn't needed for the one category that exists, and
  probing it blindly against unknown catIDs isn't productive scraping).

## Prior art used

`biglocalnews/civic-scraper`'s CivicPlus module, per
`reports/notes/prior-art.md`:

- **Ported directly**: the anchor-`name`/`id` `_MMDDYYYY-<id>` date-parsing
  quirk (`parseAnchorDate()`).
- **Ported the taxonomy idea, not the code**: agenda vs. minutes vs. packet
  URL-path typing (`/ViewFile/Agenda/` vs `/ViewFile/Minutes/`), used here to
  check for minutes presence.
- **Explicitly not used, with reason recorded**: the `/Search/?...` POST
  endpoint — blocked by this site's `robots.txt`, a real constraint the
  prior-art repo doesn't hit (it identifies as a spoofed desktop browser UA
  and doesn't appear to check robots.txt).

## Verification

- `npx tsc --noEmit`: clean.
- `node src/run-one.ts chino-agendacenter`, run twice against the real project
  DB:
  - Run 1: `{"documentsFetched":1,"documentsNew":1,"itemsSeen":1,"itemsNew":1}`
  - Run 2: `{"documentsFetched":1,"documentsNew":0,"itemsSeen":1,"itemsNew":0}`
  — idempotent as required.
- Spot-checked 3 URLs actually used by the scraper with `curl -sI`, all
  **200**:
  - `https://www.cityofchino.org/AgendaCenter/ViewFile/Agenda/_01042022-8`
    (the one item's `source_url`, minus its `#page=2` fragment) — 200,
    `content-type: application/pdf`.
  - `https://www.cityofchino.org/agendacenter` (discovery page) — 200,
    `content-type: text/html`.
  - `https://www.cityofchino.org/RSSFeed.aspx?ModID=65&CID=All-0` (RSS
    cross-check) — 200, `content-type: text/xml`.
  - (Only one item exists to spot-check as a true `items.source_url`; the
    other two are the scraper's other live-fetched URLs, included because a
    3-PDF spot-check wasn't possible with only 1 PDF in the entire Agenda
    Center — see "Volume" above.)
