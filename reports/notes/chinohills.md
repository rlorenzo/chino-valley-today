# Task 0.4 — Chino Hills agendas + news

Scrapers: `src/scrapers/chinohills-news-rss.ts` (`chinohills-news-rss`, method
`rss`) and `src/scrapers/chinohills-agendas.ts` (`chinohills-agendas`, method
`pdf`).

## Headline finding: Chino Hills' agenda platform is NOT what PLAN.md assumed

PLAN.md (Task 0.4) assumed Chino Hills exposes agendas through the same
CivicPlus "Agenda Center" module Chino uses (Task 0.2). It doesn't, in
practice. Full chain, verified live by the scraper itself (see its `ctx.note()`
output, Steps 1-4):

1. **CivicPlus native Agenda Center** (`https://www.chinohills.org/AgendaCenter`,
   ModID=65 in the RSS.aspx catalog) exists but is **decommissioned/empty** —
   0 categories configured. Confirmed by POSTing its own
   `/AgendaCenter/UpdateCategoryList` AJAX endpoint (not robots-blocked) with
   `catID=1..5,10`: every guess returns HTTP 500, which is this module's
   behavior for a catID that doesn't correspond to a configured category.
2. The real navigation hub is `https://www.chinohills.org/60/Agendas-Minutes`
   (plain CivicPlus Pages-module page, not robots-blocked). Per meeting body
   it links "Most Recent Agenda"/"All Agendas"/"All Minutes" to
   `publicportal.chinohills.org/WebLink/...` (**Laserfiche WebLink**, a
   document-management product, not CivicPlus), and separately embeds an
   `<iframe src="https://agendaquick.chinohills.org:8086/agenda/">`
   (**Agenda Quick**, a Destiny Software product — a third, distinct system).
3. **Laserfiche WebLink is robots.txt-blocked.** `publicportal.chinohills.org/robots.txt`
   sets a blanket `Disallow: /*.aspx` (matches every `Browse.aspx`/`DocView.aspx`
   URL this system uses, regardless of a separate case-mismatched
   `Disallow: /Weblink/` rule) plus `Crawl-delay: 2000` (seconds). No
   documented public API exists (`/WebLink/api/entry/<id>` and
   `/api/entry/<id>` both 404). Confirmed live by the scraper attempting one
   fetch and catching the resulting `robots.txt disallows ...` error — **not
   bypassed**.
4. **Agenda Quick is NOT blocked** — this took a live-verification catch to
   confirm. Its `robots.txt` file reads, on casual inspection, like a
   blanket block:

   ```text
   # To ban all spiders from the entire site uncomment the next two lines:
   # User-agent: *
   # Disallow: /
   ```

   Both directive lines are commented out — this is the unmodified default
   template from the underlying framework, left as-is. It has **zero active
   directives**. My first manual pass over this file (via `curl`) misread it
   as an active block and the first version of this scraper's Step 4 was
   written to expect (and gracefully log) a robots.txt rejection here. The
   *actual* scraper run instead logged `UNEXPECTED: ... was fetchable`,
   which is what caught the misreading — `fetch.ts`'s `parseRobots()`
   correctly strips `#`-comments before evaluating rules, so it never saw an
   active `Disallow` at all. **Lesson recorded in the scraper's file header
   so it doesn't get "fixed" back based on eyeballing the raw file: always
   trust the live parsed result over reading robots.txt by eye.**

Net effect: the agenda scraper (§ below) uses Agenda Quick as its real
source, not the CivicPlus module PLAN.md assumed.

## Feed enumeration (chinohills-news-rss)

`https://www.chinohills.org/RSS.aspx` (the feed-discovery/catalog page) is
robots-blocked (`Disallow: /RSS.aspx`, identical rule to cityofchino.org).
The underlying `/RSSFeed.aspx?ModID=...&CID=...` endpoints those catalog
entries point to are **not** covered by any robots rule and are fetched
normally. Full catalog hand-enumerated once out-of-band (`curl`, 2026-08-11)
by reading that same disallowed page as a one-time human research step (same
pattern `chino-news-rss.ts` uses for cityofchino.org):

| ModID | Module | Feed CIDs found |
|---|---|---|
| 1 | News & Announcements (Newsflash/CivicAlerts) | `All-newsflash.xml`, `2025-Home-Spotlight-12`, `Local-News-1` |
| 51 | Blog | `All-blog.xml` |
| 53 | Photo Gallery | `All-0` + 6 named categories |
| 58 | Calendar | `All-calendar.xml`, `Community-Calendar-14`, `McCoy-Open-Ride-Calendar-28` |
| 63 | Alert Center | `All-0`, `Emergency-1` |
| 64 | Real Estate Locator | `All-0` + 4 named categories |
| 65 | Agenda Center | `All-0` (empty — see headline finding) |
| 76 | Pages | `All-0` |
| 92 | CivicMedia™ | `All-civicmedia.xml` + 13 named categories |

Ingested: ModID=1 ("News & Announcements") only, per the brief's scope. At
survey time "Local News" (CID=`Local-News-1`) mirrored the aggregate "All"
feed exactly (4/4 items); "2025 - Home - Spotlight" was empty. The scraper
defensively cross-checks every item in "All" against the named categories and
would ingest any leftover under a synthetic "Uncategorized (via All feed)"
category if one ever appeared (none did this run).

## Agenda discovery pattern that worked (chinohills-agendas)

Real source: **Agenda Quick** at `https://agendaquick.chinohills.org:8086/agenda/`.

- Monthly listing (plain server-rendered HTML, no JS needed):
  `default.cfm?mt=ALL&month=<M>&year=<Y>` (also accepts `mt=CC`, `mt=PLAN`,
  etc. — meeting-type codes are in the page's own `<select name="mt">`: CIC,
  CC, CHCF, EDCC, LAC, PRC, PLAN, PAC, PW, TRE).
- Per-meeting page: `agenda.cfm?seq=<N>` — a clean, **complete** HTML
  rendering of the agenda (no backup materials), 20-30KB, numbered items as
  standalone `N.` heading lines.
- That page links exactly one PDF, named like `..._Agenda.pdf` or
  `..._Agenda_Packet.pdf`. Despite the filename, **it is the full packet**
  (agenda + every backup material/exhibit/resolution merged into one file) —
  confirmed by comparing its size (1.3MB-65MB across the meetings sampled)
  against the much smaller, item-only HTML rendering of the same meeting.
  This is a real data-quality/operational finding worth flagging for any
  production pipeline: packet size varies by two orders of magnitude
  meeting-to-meeting and is not predictable from the meeting type alone (the
  Aug 11, 2026 City Council packet was 65MB / 179 pages; the Aug 5, 2026
  Public Works Commission packet was 1.3MB / 16 pages).
- No minutes anywhere on Agenda Quick: checked City Council listings across
  August, June, and February 2026 — the "Minutes" link slot exists in the
  template but was empty in every meeting sampled. Minutes only exist on the
  robots-blocked Laserfiche WebLink host (per the headline finding); **not
  ingested**, per the brief.
- Bonus cross-reference for Task 0.5: recent City Council rows carry a third
  link, "Video", pointing to `chinohillsca.new.swagit.com/videos/<id>` (e.g.
  `https://chinohillsca.new.swagit.com/videos/390778` for the June 9, 2026
  meeting) — confirms the Swagit host/URL pattern PLAN.md names for Task 0.5
  and that it's reachable from this navigation path too.

Selection logic (live, not hardcoded): fetch the current + prior month's
`mt=ALL` listing, pick the single most recent meeting matching `/city
council/i` and the single most recent matching `/commission/i`. This run
selected **City Council, 2026-08-11 (seq=1167)** and **Public Works
Commission, 2026-08-05 (seq=1181)** — satisfies the brief's "City Council +
at least one commission if available."

## PDF extraction quality assessment

`extractPdfText` (pdf-parse) produces **clean prose** for both packets
sampled — no visible garbling, no header/footer text bleeding into item
bodies (footers like `3/235` are stripped before item-splitting), no
multi-column layout issues (these agendas are single-column). The only
artifact observed is occasional extra spacing inside words from certain
embedded font kerning (e.g. "C ity C ouncil", "C ouncil C hambers") —
cosmetic only, doesn't affect item boundaries or readability.

**Item-splitting heuristic**: packets merge the true numbered agenda (items
1..N) with full backup materials immediately after, which have their own
numbered sub-lists restarting at 1 (e.g. numbered findings inside an attached
resolution). A naive `/^\d+\.\s/` regex over the full packet text matched 48
times in the City Council packet (only 15 are real top-level items) and 5
times in the Public Works Commission packet (all 5 real — small packet, no
sub-lists to confuse). Heuristic used: keep a numbered match only while the
number increases by exactly 1 from the previous kept match, starting at 1;
stop at the first break. This is a strong heuristic specifically *because*
Chino Hills packets structure backup materials as literal PDF-merged
attachments (each restarting sub-numbering from 1), which is a coincidence of
this platform, not a general PDF-splitting technique — noted so it isn't
assumed to transfer directly to another city's packet format.

**Cross-check performed live in the scraper run**: also fetches the clean
HTML `agenda.cfm?seq=N` rendering (which has no backup-material bleed at
all) and counts its top-level items independently. Result for both meetings
this run: **exact match** (15/15 for City Council, 5/5 for Public Works
Commission) — strong validation that the heuristic isolates the true
top-level item list, not an accident of these two samples.

**Page-number tracking**: pdf-parse inserts a `-- N of Total --` marker
between each page's extracted text; the scraper counts markers preceding
each item's start index to compute which page it begins on, and appends
`#page=N` to every item's `source_url` (e.g.
`...CC%20Agenda.pdf#page=4`) — the brief's "only if you can actually track
page numbers" condition is met.

**Titles**: per the brief's spec (`title = the item's first line, trimmed to
~120 chars`), titles are the PDF's first visual line of each item, which
sometimes cuts mid-phrase before the item's real subject (e.g. "Conference
with Real Property Negotiator pursuant to Government Code Section" — the
actual code section number is on the next line). Acceptable POC quality per
the brief; a production version would want to join lines until the next
sentence boundary instead of a hard line-wrap cut.

**Meeting dates**: parsed cleanly from Agenda Quick's `Month Day, Year: Body
Name` listing-page heading format (e.g. "August 11, 2026: City Council
Regular") — no ambiguity, no timezone handling needed (date-only, no time
component required for `occurred_at`).

## Full-text vs teaser (PLAN open question 6 — Chino Hills data point)

**Teaser-only**, same conclusion as cityofchino.org
(`chino-news-rss.ts`). Live comparison this run: "Mobile Recreation Program"
— RSS `<description>` teaser is 117 chars; the full article, extracted from
the detail page's `#main-wrapper .article-content` (same CivicPlus template
selector as Chino), is 1,606 chars. This scraper stores the RSS teaser as
`body` per the brief's spec (`body = description text, HTML stripped`); it
fetches one detail page per run purely to answer this open question, not to
enrich stored item bodies.

## HTTP behaviors

- `RSSFeed.aspx` responses: no `ETag`, no `Last-Modified` (only
  `Content-Type`/`Content-Length`/`cache-control: private,no-transform`) —
  identical to cityofchino.org. No conditional-GET support; every response
  embeds a live `<lastBuildDate>`, so the feed *document* never hash-matches
  across runs (`documentsNew` for feed URLs is expected to be >0 every run —
  not a bug). Item idempotency instead comes from `resolveDocumentId()`
  (same pattern as `chino-news-rss.ts`, read but not modified): reuse the
  `document_id` an item's `external_id` was first captured under.
- `CivicAlerts.aspx?aid=N` detail links 302-redirect to canonicalized
  `/m/newsflash/home/detail/N` URLs; handled transparently by
  `redirect: 'follow'`.
- Agenda Quick (`agendaquick.chinohills.org:8086`): plain `Microsoft-IIS/10.0`
  - ASP.NET/ColdFusion (`.cfm`) responses, no unusual headers. PDF responses
  *do* carry `ETag`/`Last-Modified`/`Accept-Ranges: bytes` (unlike the
  CivicPlus RSS endpoints) — genuine conditional-GET support, though not
  exercised across runs in this POC since content didn't change between the
  two verification runs.
- No WAF/bot-blocking (no CAPTCHA, no 403s) observed on any host at the
  enforced 2s/host delay, for a descriptive User-Agent.

## Failure modes / open questions raised

- Packet-size variance (1.3MB-65MB) means a naive "just fetch the PDF" step
  in a production pipeline needs an explicit size/time budget or streaming
  approach if the City ever posts a much larger packet (e.g. a General Plan
  update with hundreds of pages of exhibits).
- Laserfiche WebLink (minutes, and an alternate agenda path) is fully
  robots.txt-blocked with no documented API — if minutes ever become
  editorially necessary, the only paths forward are (a) requesting
  allowlisted/API access from the city (City Clerk contact on the Agendas &
  Minutes page: 909-364-2620, `cityclerk@chinohills.org`), or (b) a periodic
  human-assisted pull, not automated scraping.
- The item-splitting heuristic's "stop at first sequence break" rule is
  specific to how Chino Hills' packets are assembled (backup materials
  restart numbering at 1) — it is not guaranteed to generalize to a
  differently-assembled packet from another Destiny Software/Agenda Quick
  client, should this project ever scrape one.
- The Agenda Quick meeting-type filter (`mt=`) codes (CIC, CC, CHCF, EDCC,
  LAC, PRC, PLAN, PAC, PW, TRE) were read from the page's own `<select>`
  options rather than documented anywhere externally; if Destiny Software
  changes this list the scraper's `/commission/i`/`/city council/i` name
  matching (done against the free-text body name, not the code) should keep
  working regardless.

## Prior art used

None applicable directly — `civic-scraper`'s CivicPlus module (per Task 0.0)
covers the Agenda Center pattern, which turned out not to be in use here.
Destiny Software's Agenda Quick is not one of the platforms `civic-scraper`
classifies (CivicPlus, Legistar, Granicus, CivicClerk, PrimeGov); no
equivalent prior art was found or needed — the platform's HTML is simple
enough that direct inspection (curl + cheerio) was sufficient.

## Verification

- `npx tsc --noEmit`: clean (full project, after a concurrently-edited
  sibling file `chino-agendacenter.ts` — not owned by this task — was also
  fixed by its own author).
- `node src/run-one.ts chinohills-news-rss` x2: run 1
  `{"documentsFetched":4,"documentsNew":4,"itemsSeen":4,"itemsNew":4}`; run 2
  `{"documentsFetched":4,"documentsNew":3,"itemsSeen":4,"itemsNew":0}` (the 1
  non-new document each subsequent run is the detail-page fetch used for the
  teaser/full-text note — the 3 feed documents always re-hash per the
  `<lastBuildDate>` quirk above, so `documentsNew` stays 3, not 0, by
  design).
- `node src/run-one.ts chinohills-agendas` x2: run 1
  `{"documentsFetched":8,"documentsNew":6,"itemsSeen":20,"itemsNew":20}`; run
  2 `{"documentsFetched":8,"documentsNew":0,"itemsSeen":20,"itemsNew":0}`.
- Spot-checked 3 `source_url`s live with `curl -sI`:
  - `https://www.chinohills.org/CivicAlerts.aspx?aid=3812` → HTTP 302 →
    `/m/newsflash/home/detail/3812` (expected redirect behavior, real page).
  - `https://agendaquick.chinohills.org:8086/docs/2026/CC/20260811_1167/1167_08-11-2026%20CC%20Agenda.pdf`
    → HTTP 200, `content-type: application/pdf`, 65,391,225 bytes.
  - `https://agendaquick.chinohills.org:8086/docs/2026/PW/20260805_1181/1181_08-05-2026%20PWC%20Agenda%20Packet.pdf`
    → HTTP 200, `content-type: application/pdf`, 1,275,653 bytes.
