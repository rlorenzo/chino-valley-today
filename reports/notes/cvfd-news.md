# cvfd-news — Chino Valley Fire District (Phase 4 Task 4.1)

Added 2026-08-17. The district serves BOTH Chino and Chino Hills, so all
content is local by construction — the highest-signal incident source for the
"what was that fire" reader question, alongside the county's sbcfire-news.

## Method

Third CivicPlus instance in the registry (after both cities). Feed catalog
enumerated live from `https://www.chinovalleyfire.org/RSS.aspx` on 2026-08-17 —
notably NOT robots-blocked on this host (cityofchino.org disallows its
/RSS.aspx; chinovalleyfire.org's robots only blocks Baidu/Yandex and admin
paths). Full catalog observed:

| ModID | Module        | Ingested as    | CID used            |
| ----- | ------------- | -------------- | ------------------- |
| 1     | News Flash    | `news_release` | All-newsflash.xml   |
| 51    | Blog          | not ingested   |                     |
| 53    | Photo Gallery | not ingested   |                     |
| 58    | Calendar      | `event`        | All-calendar.xml    |
| 63    | Alert Center  | `alert`        | All-0               |
| 65    | Agenda Center | not ingested (board/committee agendas — a future governance scraper per the chino-agendacenter precedent; per-committee CIDs exist: Board-of-Directors-2, Finance-Committee-3, …) | |
| 76    | Pages         | not ingested   |                     |

## Quirks

- **All three ingested feeds were empty on the first run** (0 items each).
  The district posts sparingly; for Alert Center, empty IS the desired steady
  state — a non-empty run means an active emergency notice and is the daily
  brief's highest-value line. The run notes call this out so a future reader
  doesn't mistake it for a broken scraper.
- Calendar items carry `calendarEvent:EventDates`/`EventTimes` (Pacific local
  wall-clock); occurred_at converts via the shared `localDateTimeToIso`
  (moved from chino-news-rss.ts to civicplus-rss.ts for this scraper),
  falling back to pubDate. Same "one timestamp, two meanings" discipline as
  the Chino calendar feed.
- Same CivicPlus volatility as the other two instances assumed
  (`lastBuildDate` re-hash); resolveDocumentId pins items on first capture.

## First run (2026-08-17)

3 documents fetched clean, 0 items (see above — expected). Scheduled
`frequent` (hourly): the Alert Center is the one feed in the registry where
polling latency directly matters.
