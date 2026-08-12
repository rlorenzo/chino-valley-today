# Task 0.6 — CVUSD Board of Education (agendas + YouTube captions)

Scrapers: `src/scrapers/cvusd-board.ts` (key `cvusd-board`) and
`src/scrapers/youtube-captions.ts` (key `youtube-captions`). Site:
`chino.k12.ca.us`, Board of Education section. YouTube: "Chino Valley Unified
School Dist Board Videos" (`UCWKinB4PTb_uskobmwBF8pw`). Research +
implementation date: 2026-08-11.

## Meetings-page discovery and structure

Homepage → "Board of Education" → "Board of Education Home"
(`/221782_2`) → "Meetings Agendas, Minutes, and Videos" (`/224768_2`, the
stable entry point `cvusd-board.ts` fetches). That URL 302-redirects to
whichever page is "current" — right now `/136685_3`, the 2026/2027 board
year. That page's left sidebar links to prior years as plain `<a>` text
("2025/2026 Meeting Dates, Agendas, Minutes and Videos", "2024/2025 ...",
"2023/2024 ...", "2022/2023 ..."), most-recent first. The scraper fetches the
current-year page plus the single most-recent prior-year link (bounded to 2
listing-page fetches total, per the volume constraint).

Each year page renders one clean, semantic HTML `<table>`
(`thead` text contains "Meeting Date") with exactly five columns per row:
**Meeting Date** (`MM-DD-YY` text, e.g. `07-16-26`) | **Meeting Type**
(Regular / Special / Organizational) | **Agenda** (link) | **Minutes**
(link, often blank until posted) | **Meeting Video** (YouTube link). This is
directly machine-parseable with cheerio — no AJAX, no JS rendering, no date
buried in an anchor attribute the way Chino's CivicPlus Agenda Center needed
(see `reports/notes/chino-agendacenter.md`). Current-year page has 1 row so
far (the district's board year runs July–June); the 2025/2026 page has 18.

**Not Finalsite.** PLAN.md's task description guessed Finalsite; response
headers say otherwise: `x-gabbart-ecs: true` and a
`Content-Security-Policy` scoped to `*.smartsites.parentsquare.com` identify
this as ParentSquare's "SmartSites" district CMS. Worth correcting in
PLAN.md/SOURCES.md if this file is read there.

## Open question 4 verdict: not BoardDocs, not Simbli

**Neither.** Across all 19 meeting rows scraped, every Agenda link resolves
to `files.smartsites.parentsquare.com` — the CMS's own asset host, not a
board-management-service. Evidence:

- Response headers on the PDF fetches: `x-amz-server-side-encryption:
  AES256`, `x-amz-version-id: ...`, `x-amz-replication-status: COMPLETED` —
  an S3-backed static file bucket, not an application server.
- No `boarddocs.com` or `simbli.eboardsolutions.com` reference anywhere on
  either listing page (checked by grep against the raw HTML).
- The PDFs themselves are full **packets** (8–13 MB each, 100+ pages: cover
  page + trustee/superintendent roster + the actual agenda + the full staff-
  report backup material for every consent item, concatenated into one
  file), which is a static-CMS publishing pattern, not what a BoardDocs/
  Simbli item-by-item structured system would produce.
- No structured JSON/API endpoint was found or expected — there's nothing
  resembling Legistar's `webapi.legistar.com` pattern here.

**Minutes are a partial exception, not a BoardDocs/Simbli one.** Some
Minutes links (never Agenda links, in the 19 rows observed) route through
`chinovalley-my.sharepoint.com/personal/pat_kaylor_chino_k12_ca_us/...`
share links. `curl -sI` on one of these returns a `302` to
`.../_layouts/15/onedrive.aspx?...` with `Set-Cookie: FedAuth=...` — an
authenticated SharePoint/OneDrive viewer, not a direct file stream. These
are not fetchable without a Microsoft login and were **not** ingested or
used as `source_url` substitutes; the scraper records `minutesHost:
'sharepoint'` in each affected row's `meta` and moves on. This is
personal-OneDrive sharing (a staff member's own document library), most
likely an ad hoc workaround from whoever posts minutes some weeks — not a
platform CVUSD deliberately adopted.

## New finding not anticipated by the open question: the PDF host blocks robots

`files.smartsites.parentsquare.com/robots.txt`:

```
User-agent: Googlebot-Image
Allow: /

User-agent: *
Disallow: /
```

`chino.k12.ca.us` itself has no such restriction on the listing pages
(its `robots.txt` only blocks `/admin`, `/*lesson_plan`, `/userFiles`, and
sets `Crawl-delay: 5`, which `fetch.ts`'s fixed 2s per-host delay doesn't
honor per-directive — a shared-infra observation, not something fixable
from these two owned files). But every agenda PDF is fetched from the
*asset host*, and that host's blanket `Disallow: /` makes `politeFetch`
throw `robots.txt disallows ...` before issuing any GET — confirmed live
against the actual scraper code, not assumed.

**Decision: did not bypass.** Per this task's explicit instruction ("a
block is a finding, not something to bypass") and the narrower bar
`ScraperContext.fetchDocument`'s own doc comment sets for `skipRobots`
("ONLY for documented public APIs whose robots.txt targets crawlers, not
API clients"), this doesn't qualify: it's a blanket SEO-crawler exclusion
on a static file bucket, not a documented API (unlike `api.weather.gov`,
the `nws-alerts.ts` precedent). `cvusd-board.ts` attempts
`ctx.fetchDocument` on the 2 most recent agenda PDFs, catches the thrown
error, and `ctx.note()`s it — no `agenda_item` rows are produced as a
result. **Recommendation for the team**: either (a) explicitly approve a
narrowly-scoped `skipRobots` exception for this one host with a documented
rationale (the files are individually linked from a page we're already
allowed to crawl, not discovered by crawling the bucket itself; a browser
doesn't consult robots.txt when a human clicks the same link), or (b)
accept listing-level coverage only for CVUSD board agendas going forward.
Not resolved unilaterally here since it's a policy call, not an
implementation one.

## PDF extraction quality (evidence gathered outside the scraper's own fetch path)

Because the scraper itself can't legally fetch the PDF bytes (see above),
the two most recent agenda PDFs (`07-16-26_agenda.pdf`, `06-18-26_agenda.pdf`)
were downloaded by hand with `curl` during research — outside `politeFetch`,
purely to validate `extractPdfText` + the item-splitter against real CVUSD
documents before writing the splitter. This is documentation of what the
code *would* produce if the block above is lifted; it is not something the
shipped scraper does at runtime.

- `extractPdfText` handled both cleanly: **110 pages / 168,818 chars**
  (07-16-26) and **158 pages / ~230k chars** (06-18-26) of selectable text,
  no OCR artifacts.
- CVUSD's packets use **hierarchical item numbering** — `II.A.1.`, `III.B.4.`,
  etc. — one item number alone on its own line, immediately followed by
  `Page N` (the packet's own backup-material page label), then a title line,
  then a one-sentence recommendation. Much more regular than Chino's
  Agenda Center PDFs (`reports/notes/chino-agendacenter.md`'s plain `1.`/`2.`
  numbering).
- Item-splitter (`splitAgendaItems()` in `cvusd-board.ts`): bound the search
  to the region between the standalone `AGENDA` heading and the first
  `<Roman>. ADJOURNMENT` line (same "bracket, then split" strategy as
  `chino-agendacenter.ts`, adapted to the `<Roman>.<Letter>.<N>.` pattern),
  then match `^([IVXLC]+\.[A-Z]\.\d+)\.\s*$`. Result: **21 items** on
  07-16-26, **31 items** on 06-18-26 — both fully coherent (title +
  recommendation text, correct `Page N` extracted for the `#page=N`
  fragment on every item, zero false positives from the ~90 pages of staff-
  report/MOU attachments that follow the boundary and which do contain
  their own unrelated roman-numeral section headers that would otherwise
  false-positive).
- **Known limitation**: only captures the `<Roman>.<Letter>.<N>.` tier
  (Consent and Information sections — the substantive votable items). The
  "I. OPENING BUSINESS" procedural items (roll call, closed session
  agenda `a.`–`k.` lettered items, recognitions) use a *different*, flatter
  numbering scheme (`1.`, `2.`, `3.` under bare subsection headers like
  "I.A. CALL TO ORDER") and are not split out individually — same
  class of honest POC-quality gap as the sibling scraper's lettered-sub-item
  limitation.

## What was ingested

**`cvusd-board`** (per real run against the project DB):
- 2 documents (`doc_type: 'listing'`): the current-year page (`/224768_2`,
  redirects to `/136685_3`) and the 2025/2026 page (`/253390_3`).
- 19 items (`item_type: 'event'`), one per meeting row across both listing
  pages, `external_id: '<date>-meeting'`, `source_url` = the agenda PDF URL
  (falling back to video, then minutes, then the listing page itself if a
  row somehow has none), `occurred_at` = meeting date, `meta` carrying
  `meetingType`, `agendaUrl`, `minutesUrl`, `minutesHost`, `videoUrl`. These
  work regardless of the robots.txt block — they're parsed straight from
  crawlable HTML and link to URLs a human's browser can open directly (all
  spot-checked 200, see Verification).
- 0 `agenda_item` rows (blocked — see above).

**`youtube-captions`**:
- 1 document (`doc_type: 'captions'`): the July 16, 2026 board meeting video
  (`hRO51ueaqb4`), archived as raw VTT bytes via `saveRaw`.
- 131 items (`item_type: 'transcript_segment'`), `external_id:
  '<videoId>-<index>'`, `body` = merged segment text, `occurred_at` =
  meeting date parsed from the video title, `source_url` =
  `https://www.youtube.com/watch?v=hRO51ueaqb4&t=<N>s`, `meta: {videoId,
  startSeconds, endSeconds}`.

## yt-dlp commands used

1. **List recent uploads** (channel, not per-video — avoids extra calls):
   ```
   yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(duration_string)s" \
     --playlist-end 15 https://www.youtube.com/channel/UCWKinB4PTb_uskobmwBF8pw
   ```
   `--flat-playlist` conveniently exposes `duration_string` without a
   separate full-metadata call per video (`upload_date` is `"NA"` in flat
   mode, which is why selection uses the date parsed out of each title
   instead — see below).
2. **Download auto-captions for the chosen video only**:
   ```
   yt-dlp --skip-download --write-auto-sub --sub-format vtt --sub-langs en \
     -o "<tmpdir>/%(id)s" https://www.youtube.com/watch?v=hRO51ueaqb4
   ```
   yt-dlp appends `.en.vtt`, confirmed (`<tmpdir>/hRO51ueaqb4.en.vtt`).

Total yt-dlp invocations per run: **2** when a fresh video needs captions
(listing + download), **1** on any re-run against an already-archived video
(listing only — `ctx.db.latestDocument(watchUrl)` short-circuits the
download; verified: run 2 completed in ~1s vs ~4s for run 1, with
`documentsNew: 0`).

**Video selection quirk worth recording**: `--flat-playlist` order on this
channel is **not strictly chronological** — a 46-second April 2026 stub
outranked a full-length January 2026 meeting in one listing pull. The
channel also posts a short (~1 minute) "closed session" stub alongside most
full meetings, same title, same date. Selection logic: parse a date out of
each title (`/([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})/`), filter to
`/board|meeting/i` titles with a parseable date, sort by `(date desc,
duration desc)`. This picked `hRO51ueaqb4` (42:16) over its same-date
companion `jDPJp9R3mh0` (1:20) correctly, and the chosen video URL matches
exactly what `cvusd-board.ts` independently parsed as the `videoUrl` for
the 2026-07-16 row — two independent extraction paths agreeing.

## VTT parsing approach (rolling-cue handling)

YouTube auto-caption VTT displays a rolling two-line window: each cue
repeats the *previous* cue's finished line as line 1, then grows a new
line 2 word-by-word via inline `<HH:MM:SS.mmm><c>word</c>` timing tags,
alternating with near-zero-length "transition" cues whose line 2 is blank.

**The subtlety that actually matters**: keeping only each cue's last
non-blank line is *not* sufficient by itself. A transition cue's line 2 is
blank, but its line 1 (the just-finished text) survives the blank-filter
and becomes that cue's "last line" too — identical to the text already
kept from the previous cue. So every real line is naturally followed by
exactly one duplicate. **This bit the first implementation**: an early
version of `parseRawCues()` shipped without an explicit consecutive-
duplicate check, on the mistaken assumption that blank-filtering alone was
enough (validated against only a short hand-eyeballed sample where the
duplication pattern wasn't obvious at a glance). It was caught before
delivery by reading the actual archived rows back out of the project DB —
every phrase appeared twice ("I now reconvene the regular meeting of I now
reconvene the regular meeting of..."). Fixed by adding an
equality-against-the-immediately-previous-kept-line check on top of the
blank filter; the stale duplicated rows were deleted from the DB and
regenerated. Final approach, verified against the real 42-minute meeting:
**1846 raw cue blocks → 939 non-blank, non-duplicate content lines**, read
back with no visible repeats or gaps at line boundaries.

Those 939 fine-grained lines (~2 seconds / ~7 words each) are then merged
into coarser `transcript_segment` rows using a rolling accumulator bounded
by **20 seconds of span or 500 characters**, whichever comes first — this
produced **131 segments** for the 42-minute video, a readable paragraph-ish
size rather than one DB row per caption line. `&gt;`/`&lt;`/`&amp;`/`&#39;`/
`&quot;` HTML entities (YouTube uses `&gt;&gt;` as a speaker-change marker
in these captions) are decoded during cleanup. Well under the ~1000-segment
cap; no truncation triggered for this video, but the cap and its
`ctx.note()` are wired for longer meetings (some in the channel's history
run 2.5 hours).

## Caption quality on proper names

Confirmed **auto-generated ASR only**: `yt-dlp --list-subs` for `hRO51ueaqb4`
reports `"hRO51ueaqb4 has no subtitles"` — no manually-authored/official
caption track exists on this channel, only YouTube's automatic captions (the
`--list-subs` "available automatic captions" section lists ~100
auto-translated language variants, all derived from the same underlying
English ASR).

Three concrete garbling examples from this one meeting, directly relevant to
Phase 1's Gate 1c (proper-name whitelist) design:

1. **Trustee James Na → "Naw" / "N" / "Na"** — the same five-trustee roll
   call ("Cervantes, Cruz, Na, Shaw, and Smith") is read aloud multiple
   times during the meeting (once at reconvene, again for each closed-
   session vote tally). The short two-letter surname "Na" is transcribed
   three different ways across those readings: "Naw" (0:23), a bare "N"
   (0:59, dropped to a single letter), and correctly "Na" (1:18) — same
   name, same speaker, three different outputs.
2. **Staff appointee → "Elise Jükley"** — a new coordinator-of-special-
   education appointee's name comes out with an inserted umlaut mid-name,
   almost certainly a garbled real surname (English ASR models have no
   reason to invent diacritics; this reads like a phonetic best-guess on an
   unfamiliar name).
3. **"Megan" vs. "Miss Reagan"** — the district's Executive Assistant is
   addressed as "Megan" once early in the meeting, then thanked as "Miss
   Reagan" a few lines later — same person, two different transcribed
   names within the same meeting.

This lines up with `reports/notes/prior-art.md`'s CityMeetings.nyc section:
proper-name transcription errors are common, and Oberoi's writeup describes
them as effortful to fully automate away — which is exactly the argument
for a validation *gate* (reject/hold on unrecognized names) rather than
attempting inline correction at synthesis time.

## Video cadence

Roughly one video pair per board meeting — a ~1-minute closed-session stub
plus the full open-session recording (20 minutes to 2.5+ hours depending on
agenda load) — matching the ~2×/month regular-plus-special cadence visible
in `cvusd-board.ts`'s own listing-page rows. Uploads on this channel go back
to at least November 2020.

## Failure modes

- **Agenda PDF full-text ingestion is blocked entirely** by
  `files.smartsites.parentsquare.com/robots.txt` under the current
  politeness policy (see above) — the single biggest gap versus the task
  brief's ask. Listing-level coverage (19 `event` items with working
  source_urls) exists regardless.
- **Minutes on SharePoint personal-share links are not ingestible** without
  a Microsoft login; treated as a dead end, not retried.
- **CVUSD's Crawl-delay: 5 directive isn't honored** by the shared
  `fetch.ts` (fixed 2s delay) — an infra gap outside these two owned files,
  noted rather than silently ignored.
- **Item-splitter only covers the hierarchical `<Roman>.<Letter>.<N>.` tier**
  (Consent/Information sections), not the flatter Opening Business
  procedural sub-items — see PDF extraction quality above.
- **`--flat-playlist` order is not chronological** and required date-parsed-
  from-title selection logic rather than trusting list position or
  `upload_date` (unavailable in flat mode).
- **First cut of the VTT rolling-cue parser had a real duplication bug**
  (documented above under "VTT parsing approach") — caught by reading
  actual archived DB rows back, not by unit-testing the parser in
  isolation. Fixed; verified clean on re-run.

## Prior art used

None applicable per `reports/notes/prior-art.md`'s own task-mapping table
("No repo surveyed has a Finalsite, BoardDocs, or Simbli scraper"; the
SmartSites/ParentSquare CMS found here isn't covered by any of the five
surveyed repos either). `CityMeetings.nyc`'s proper-name-garbling findings
(prior-art.md §5) are cited above as independent confirmation of the same
class of error observed directly in CVUSD's captions.

## Verification

- `npx tsc --noEmit`: clean.
- `node src/run-one.ts cvusd-board`, run twice against the real project DB:
  - Run 1: `{"documentsFetched":2,"documentsNew":2,"itemsSeen":19,"itemsNew":19}`
  - Run 2: `{"documentsFetched":2,"documentsNew":0,"itemsSeen":19,"itemsNew":0}`
  — idempotent as required.
- `node src/run-one.ts youtube-captions`, run twice against the real project
  DB (after the VTT-parser fix described above; a stale buggy run was
  cleaned out of `items` before final verification):
  - Run 1 (fresh, downloads captions): `{"documentsFetched":1,
    "documentsNew":1,"itemsSeen":131,"itemsNew":131}`
  - Run 2 (reuses archived VTT, skips yt-dlp download, ~1s vs ~4s):
    `{"documentsFetched":1,"documentsNew":0,"itemsSeen":131,"itemsNew":131}`
    on the parser-only rerun, then a genuine idempotent third run:
    `{"documentsFetched":1,"documentsNew":0,"itemsSeen":131,"itemsNew":0}`
  — idempotent as required, and the "skip re-download" path is exercised
  (confirmed via the `ctx.note()` log line and the run-time drop).
- Spot-checked 3 `source_url`s actually stored in `items`, all **200**:
  - `https://www.youtube.com/watch?v=hRO51ueaqb4&t=21s` (a
    `youtube-captions` `transcript_segment` source_url) — 200,
    `content-type: text/html` (YouTube watch page).
  - `https://files.smartsites.parentsquare.com/7144/07-16-26_agenda.pdf`
    (a `cvusd-board` `event` item's source_url, most recent meeting) — 200,
    `content-type: application/pdf`. Reachable to a normal browser UA even
    though `politeFetch` itself won't touch this host — see robots.txt
    finding above.
  - `https://files.smartsites.parentsquare.com/7144/07-01-25_agenda_index_sm_closed_session.pdf`
    (a `cvusd-board` `event` item's source_url, oldest meeting in the
    ingested range) — 200, `content-type: application/pdf`.
