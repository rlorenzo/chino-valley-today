# Task 0.5 — Chino Hills Swagit council meeting transcripts

Scraper: `src/scrapers/chinohills-swagit.ts`. Method: `captions` (embedded
machine transcript in the video page HTML; no VTT/JSON endpoint exists — see
endpoint discovery log below).

## Prior art

None applicable. `prior-art.md`'s Task 0.5 row: confirmed (not merely
assumed) that `cdp-scrapers`' video/caption handling targets Legistar/
Granicus-hosted video only, with no Swagit support anywhere in the repos
surveyed. `CityMeetings.nyc`'s chapterization technique is relevant to what a
later phase *does* with a transcript, not to extracting one. PLAN.md's own
statement stands: no maintained OSS Swagit extractor exists.

## Endpoint discovery log

Every URL tried, in the order investigated, with result. Base video used for
all per-video probes: id `393508` ("City Council Meeting", Jul 14, 2026 — the
most recent Council meeting at scrape time).

| URL | Result |
|---|---|
| `https://chinohillsca.new.swagit.com/` | 302 → `/city-council-meeting/` |
| `https://chinohillsca.new.swagit.com/city-council-meeting/` | 200, but `<table id="video-table"><tbody>` is **empty** in the raw HTML. Confirmed with a real Chrome instance (devtools network panel + accessibility snapshot), not just curl: zero XHR/fetch requests fire after load, and the rendered DOM's video table genuinely has no rows. Page `<title>` is "SwagitAdmin" — this looks like an admin-skinned public view that never populates client-side. **Dead end as a listing source.** |
| `https://chinohillsca.new.swagit.com/robots.txt` | 200, but every `User-agent`/`Disallow` line is commented out (stock Swagit template: `# To ban all spiders from the entire site uncomment the next two lines`). Site is fully open to crawlers. |
| `https://chinohillsca.swagit.com/` (legacy domain, no `new.`) | 301 → `https://chinohillsca.new.swagit.com/views/default/` |
| `https://chinohillsca.new.swagit.com/views/default/` | 302 → `/views/158` — **this is the `/views/...` pattern PLAN.md said to watch for.** |
| `https://chinohillsca.new.swagit.com/views/158` | 200, server-rendered HTML with real `<tr>` rows: 42 videos, each with a title, a "Jul 14, 2026"-style date column, duration, and `/videos/<id>` + `/videos/<id>/agenda` links. **This is the listing source used.** Reached in the scraper by fetching `/views/default/` directly (same host, `fetch()`'s `redirect: 'follow'` chases the one remaining hop). |
| `https://chinohillsca.new.swagit.com/videos/393508` | 200, ~2.6 MB HTML. Contains the full machine transcript embedded directly: `#transcript-fragments` holds one `<p>` per caption line, each built from word-level `<a data-ts="4.605" onclick="seek(4.605);">WORD</a>` anchors (`data-ts` = float seconds from meeting start). **This is the parse source.** |
| `https://chinohillsca.new.swagit.com/videos/393508/transcript` | 200, `Content-Disposition: attachment; filename="chinohillsca-2026-07-14-City_Council_Meeting.txt"`, ~100 KB plain text. Same transcript text, organized in paragraphs with bracketed chapter markers (e.g. `[ CONSENT CALENDAR (10 ITEMS) ...]`) and periodic `[00:05:01]`-style timestamp headers every ~5 minutes — but **no per-line/per-word timestamps**. Archived as a secondary reference document (docType `captions`); not the parse source. |
| `https://chinohillsca.new.swagit.com/videos/393508/captions` | 200, `text/html` — but byte-for-byte **the same full video page**, not a distinct captions resource. Likely just an alias route. |
| `https://chinohillsca.new.swagit.com/videos/393508.vtt` | 500 (server error) |
| `https://chinohillsca.new.swagit.com/videos/393508/captions.vtt` | 500 |
| `https://chinohillsca.new.swagit.com/videos/393508.json` | 500 |
| `https://chinohillsca.new.swagit.com/videos/393508/transcript.json` | 200, but **identical bytes** to `/transcript` (same ETag, same `.txt` filename in `Content-Disposition`) — Rails is ignoring the unrecognized format suffix and serving the default text action. Not real JSON. |
| `https://chinohillsca.new.swagit.com/videos/393508/transcript.vtt` | 200, same as above — not real VTT, identical bytes to `/transcript`. |
| `https://chinohillsca.new.swagit.com/captions/393508` | 404 (PLAN.md's other suggested pattern guess — doesn't exist here) |
| `https://chinohillsca.new.swagit.com/videos/393508/download` | 302 → a presigned S3 URL (`granicus-aasmp-swagit-video` bucket) for the raw MP4. Confirms the video hosting backend; not transcript-related, not used. |
| `https://chinohillsca.new.swagit.com/videos/393508/agenda` | 302 → `https://agendaquick.chinohills.org:8086/agenda_publish.cfm?...` — a **third** Chino Hills agenda backend (distinct from whatever `chinohills.org/60/Agendas-Minutes` turns out to use for Task 0.4). Out of scope here (outside this file's ownership) but worth flagging for whoever builds 0.4. |

**Bottom line: no VTT or JSON transcript endpoint exists on this Swagit
deployment.** The richest available source is the word-level `data-ts`
anchors embedded in the video page's own HTML, which is what this scraper
parses. The `/transcript` download is real but strictly less useful (no
per-word timing) and is archived only as a secondary artifact.

## Fetch method that worked

1. `ctx.fetchRaw` on `/views/default/` (discarded — a listing page, not
   archived per the scraper contract) → 42 dated video rows, sorted newest
   first.
2. Walk newest-first, `ctx.fetchDocument` (docType `video`) each candidate's
   `/videos/<id>` page until one has a non-empty `#transcript-fragments`.
   The most recent meeting (393508) had one on the first try; the fallback
   loop (capped at 5 candidates) exists for the case where the newest meeting
   hasn't had voice-to-text run yet.
3. Parse `#transcript-fragments` with cheerio: one segment per `<p>` that
   contains at least one `data-ts` anchor (segments without anchors are
   chapter markers / periodic timestamp headers, skipped — see "Transcript
   format" below).
4. Run the endpoint-discovery probes above via `ctx.fetchRaw`, then
   `ctx.fetchDocument` the plain-text `/transcript` endpoint (docType
   `captions`) as a secondary archive.
5. Verify the `?ts=` deep-link mechanism (see dedicated section below).
6. Insert one `transcript_segment` item per paragraph.

Target meeting: **video 393508, "City Council Meeting", 2026-07-14**, 1h28m,
**1084 transcript_segment items** (well under the ~1500 volume-bound
threshold — no truncation needed this run).

Final counts, clean-DB run:
```
Run 1: {"documentsFetched":2,"documentsNew":2,"itemsSeen":1084,"itemsNew":1084}
Run 2: {"documentsFetched":2,"documentsNew":1,"itemsSeen":1084,"itemsNew":0}
```
Both runs completed in ~35 seconds, well inside the ~4-minute budget.

## A real idempotency bug found and fixed during this run

The video page's HTML embeds a fresh CSRF token (`<meta name="csrf-token">`)
and session cookie on every response, so its `content_hash` — and therefore
its `documents.id` — differs on **every** fetch, even though the visible
transcript content is unchanged. This is the same class of finding as
chino-legistar's `MeetingDetail.aspx` ETag instability. The difference: this
scraper's items are derived **directly from** that unstable page (the
per-word timestamps live only in its HTML), whereas chino-legistar's unstable
HTML fetch is only used for permalink lookup, with items coming from a
separate, stable JSON endpoint.

First implementation attached `items.document_id` to the video-page document.
Because `items` dedupe on `(document_id, external_id, item_type)`, a changing
`document_id` meant every item looked "new" on every run despite having the
same `external_id` — run 2 reported `itemsNew: 1084`, not 0. Confirmed via
direct DB inspection: three separate scraper runs produced three different
`content_hash` values for the `video`-doctype document, while the
`captions`-doctype plain-text transcript document kept the **same**
`content_hash` across all three (it has no CSRF token or session-specific
content in its body).

Fix: items now attach to the plain-text transcript document (`docType
captions`) instead of the video-page document. That document's content is
stable, so its `document_id` doesn't change run to run, and the dedup key
holds. Verified: after the fix, a clean two-run sequence produced
`itemsNew: 1084` then `itemsNew: 0`, as shown above. `documentsNew: 1` on run
2 is expected and harmless — it's the video-page document being re-archived
under a new id each time (still deduped by `(url, content_hash)` per-row, just
never matching a prior row); it doesn't affect any item.

## Transcript format found

**HTML-embedded, word-level timestamped** — not VTT, not JSON. Structure
(from `/videos/<id>`, inside `#transcript-fragments`):

```html
<p style="text-indent: 16%;">
  <a href="#" data-ts="5.055" onclick="seek(5.055); return false;" ...>THAT </a>
  <a href="#" data-ts="5.275" onclick="seek(5.275); return false;" ...>OPEN </a>
  ...
</p>
```

Cheerio (HTML5-compliant parsing, auto-closing some malformed nested `<p>`
tags present in the raw source) found **1172** `<p>` elements for this
meeting: **1084** contain `data-ts` anchors (real transcript segments — what
gets stored) and **88** don't (chapter/section markers like
`[ CONSENT CALENDAR (10 ITEMS) ...]` and periodic `[00:05:01]`-style headers
inserted roughly every 5 minutes — skipped, not spoken content). No empty-text
segments, no duplicate start timestamps.

Per-segment fields stored: `body` = the paragraph's words joined with
spaces; `meta.startSeconds` = the first word anchor's `data-ts` in that
paragraph; `meta.endSeconds` = the last word anchor's `data-ts` in the same
paragraph (an approximation of when the *last word started*, not
necessarily when the segment finished being spoken — no per-word duration is
available from this source, only start offsets). `meta.videoId` = the numeric
Swagit video id. `external_id` = `<videoId>-<segmentIndex>` (0-based, in
document order).

## Timestamp deep-link — PLAN.md open question 3: **VERIFIED, server-side**

**Verdict: `?ts=SECONDS` is genuinely supported and is what `source_url`
uses.** This is a confirmed finding, not an inference — here's exactly what
was checked and what wasn't.

The video page's own "Share" tab UI builds a shareable link with
`$('#url').val(base_url + "?ts=" + round_seconds)` — that's a claim from the
site's own client JS, which by itself would only be suggestive. So instead of
trusting that, the scraper fetches the same video URL twice — once plain,
once with `?ts=120` — and diffs the two server responses:

- **Without `?ts=`**, the page's on-play seek initializer (present twice: one
  block for a `video.js` player path, one for a `jwplayer` fallback path)
  reads a URL **hash fragment**, not a query param:
  ```js
  if (location.hash) {
    hash = location.hash.replace(/^#/, '').replace(/^&start=/, '');
    hash = parseInt(hash); hash = isNaN(hash) ? 0 : hash;
    jwplayer("player").seek(hash);   // (and the video.js path: player.currentTime(hash))
  }
  ```
- **With `?ts=120`**, the server-rendered HTML is different: both of those
  blocks are replaced outright with a hardcoded call —
  `jwplayer("player").seek(120);` and `player.currentTime(120);` — baked
  directly into the returned page, with the `location.hash` branch gone
  entirely.

That's the server computing and returning a **different response body**
depending on the `?ts=` query param, which is direct, checkable evidence that
the param is parsed server-side and wired into the player's init call — not
merely "the client JS says it should work." The scraper re-runs this exact
diff as a live probe (`verifyTsDeepLink` in the scraper file) and only sets
`tsSupported = true` if the hardcoded-seek pattern appears and the generic
`location.hash` pattern is gone; on this run it was.

**What was NOT verified**: actual visual playback — i.e., loading the page in
a real browser, letting the video element initialize, and confirming
`currentTime` genuinely lands on 120 after the user presses play. That would
require driving a real `<video>`/jwplayer instance and observing runtime
state, which is a materially different (and heavier) check than diffing
server-rendered HTML; it wasn't run. So the honest framing is: **"verified
server-side that the parameter is parsed and rewires player init" — not
"visually verified playback seeks correctly."** Given the server-rendered
code path is unconditional (`jwplayer("player").seek(120)` runs on first
play, no feature-detection or fallback branch that could silently no-op), the
server-side evidence is strong enough that `source_url` uses
`<video_url>?ts=<startSeconds>` for every segment. All three spot-checked
`?ts=`-bearing URLs returned HTTP 200 (see below).

## Caption quality on proper names (feeds the Phase 1 name-whitelist)

This is voice-to-text, explicitly unedited (the transcript page itself
carries the disclaimer "This transcript was created by voice-to-text
technology... has not been edited for errors or omissions"). Three concrete
examples, all found in a single ordinary meeting without needing to search
for edge cases — which is itself the argument for why Gate 1c can't be
skipped for anything sourced from these transcripts:

1. **The city's own name**: "CHINO HILLS" is transcribed correctly dozens of
   times, but "CHINO HILL" (dropped terminal S) also appears 6 times in the
   same transcript — including in the very first substantive sentence
   ("...OPEN OUR CHINO HILL CITY COUNCIL MEETING FOR JULY 14TH").
2. **The presiding Mayor's surname**: clearly "MARQUEZ" (transcribed
   correctly 8 times, e.g. "VICE MAYOR MARQUEZ" in roll-call/motion context),
   but the same person is also rendered as "MARQUE", "MARK", "JOSS", "JOES",
   and "JOE'S" elsewhere in the meeting — **six** distinct spellings of one
   name.
3. **A development project name**: a staff presenter says "the VILLA BORBA
   project" and, within roughly a minute of continuous presentation on the
   same topic, the transcript renders it as "VILLA BORBA", then "VILLA BOVA",
   then "VILLA BBA" — three different spellings from the same speaker
   discussing the same thing in the same breath. A public commenter's name is
   separately rendered as "JEFFREY VILLA DLI", which reads like a mangled
   surname cut short.

## HTTP behaviors

- **robots.txt**: fully open (see endpoint log above); no `skipRobots` used
  anywhere.
- **ETag / conditional GET**: the video page's `ETag` header changes on every
  request (weak validator, but genuinely different bytes each time due to
  the embedded CSRF token) — conditional GET does not produce 304s for this
  page. The plain-text `/transcript` endpoint's actual body content is
  stable across requests (confirmed via `content_hash` in three separate
  fetches), even though its `ETag` header also isn't a useful cache
  discriminator to rely on blindly — the scraper relies on the *store's*
  content-hash dedup (`db.insertDocument`), not on this endpoint returning
  304s.
- No auth required anywhere probed; no rate-limiting observed beyond the
  fetcher's own polite 2-second per-host delay.

## Failure modes handled

- Most-recent listing row lacking a transcript: falls back through up to 5
  newest-first candidates (not needed this run — the newest meeting had one).
- Plain-text `/transcript` endpoint unavailable: falls back to attaching
  items to the video-page document directly, with an explicit
  `ctx.note()` warning that idempotency won't hold in that case (not
  triggered this run — the endpoint was available).
- Listing view (`/views/default/`) itself failing: scraper notes and returns
  cleanly rather than throwing (not triggered this run).
- Volume bound: if a transcript exceeds ~1500 segments, only the first 1000
  are stored and the truncation is noted (not triggered this run — 1084 is
  under the threshold).

## Spot-checked source_urls (curl -sI)

```
https://chinohillsca.new.swagit.com/videos/393508?ts=5      -> HTTP/2 200
https://chinohillsca.new.swagit.com/videos/393508?ts=2030   -> HTTP/2 200
https://chinohillsca.new.swagit.com/videos/393508?ts=5306   -> HTTP/2 200
```

## Open items / not done

- Did not attempt any other meeting body type on this Swagit instance (the
  `/views/158` listing covers "City Council Meetings" specifically; other
  tabs seen on the SPA shell — Internal Archive, State of the City, City
  Videos, Internal, Recycle Bin — were not probed, out of scope for this
  task).
- Did not visually verify `?ts=` playback in a running browser (see deep-link
  section above for exactly what was and wasn't checked).
- The `agenda_publish.cfm` (agendaquick.chinohills.org) redirect discovered
  via `/videos/<id>/agenda` is a bonus finding for Task 0.4, not acted on
  here (outside this file's ownership).
