# Tribe Events calendars — sbclib-events, sbparks-events, cbwcd-events, yanksair-events

One dossier for four source keys (Phase 4 Task 4.1, added 2026-08-17): they
share a platform (WordPress + The Events Calendar), a scraper core
(`src/scrapers/tribe-events.ts`), and a failure taxonomy. Per-key specifics
below.

## Shared method

REST API `GET https://<host>/wp-json/tribe/events/v1/events` with
`start_date=YYYY-MM-DD&per_page=50&page=N[&venue=<id>]` →
`{ events, total, total_pages }`. Verified per-host with live probes
2026-08-17. Venue ids discovered via `/wp-json/tribe/events/v1/venues?search=`.

- Per-event permalinks are stable: `/event/<slug>/` with a trailing `/<date>/`
  for recurring occurrences — item-level link-back everywhere.
- `utc_start_date`/`utc_end_date` are UTC by API contract ("YYYY-MM-DD
  HH:MM:SS"); converted to ISO instants for occurred_at.
- **external_id = `<id>:<utc_start_date>`**: recurring events return one entry
  per occurrence and per-occurrence id uniqueness was NOT verified, so the id
  is belt-and-suspendered with the start instant.
- The events JSON re-hashes as the date window rolls → every run mints a fresh
  document; items pin to first capture via resolveDocumentId.
- Pagination capped at 3 pages (150 events) per query, noted when hit.
- Titles/descriptions carry HTML entities and markup (`&#8211;`, `<p>`) —
  stripHtml decodes/strips both.

## sbclib-events — SB County Library, Chino Valley branches

- Host: `library.sbcounty.gov`. **NEVER sbclib.org** — that hostname's
  Cloudflare WAF 403s scripted and real-browser probes alike (2026-08-17 it
  temporarily IP-flagged the dev machine after two curl requests). The county
  hostname serves the identical WordPress openly; robots.txt disallows only
  /wp-admin/.
- Venues: 1181 Chino Branch, 1250 James S. Thalman Chino Hills Branch,
  1241 Cal Aero Preserve Academy Branch. Queried one venue at a time (the
  `venue` param takes a single id).
- Age-group categories ride in meta.categories ("Library Beginners (0-5
  years)", "Kids Zone (6-11 years)", "Families (all ages)", "Adults (18+)") —
  ready-made daily-brief grouping for kids programming.
- First run: 152 events (61 + 71 + 20 per venue, matching the API's own
  totals).

## sbparks-events — SB County Regional Parks (Prado)

- Host: `parks.sbcounty.gov`, venue 1897 (Prado Regional Park — the only
  regional park in the coverage area). robots: wp-admin only.
- Sparse calendar (2 events on first run — recurring Equine Education Days);
  lookback widened to 7 days so seasonal festivals stay visible between runs.

## cbwcd-events — Chino Basin Water Conservation District

- Host: `cbwcd.org`, whole calendar (the district IS the coverage area).
  robots: Yoast default, fully open. ICS export also exists; REST chosen for
  structured categories and occurrence ids.
- First run: 20 events — compost giveaways, DIY landscape/water-feature
  workshops, district holidays. The free-workshop content is core daily-brief
  material; district holidays may deserve assembler-side filtering (they're
  closure notices, not events — decide in Task 4.3).

## yanksair-events — Yanks Air Museum (Chino Airport)

- Host: `yanksair.org`, whole calendar. robots.txt resolves ONLY at
  `www.yanksair.org/robots.txt` (bare hostname 404s the file): wp-admin only
  plus `Crawl-delay: 10`, honored via an extra 8s request gap on top of
  politeFetch's 2s floor. Daily scheduling keeps total load at ~1 request/day.
- First run: 4 events, listed through mid-2027 (Coffee With a Cop, Veterans
  Day free admission, 2027 airframe events).

## Scheduling

All four run in the `daily` group — event calendars change when staff post,
and daily cadence keeps every host far inside its politeness budget.
