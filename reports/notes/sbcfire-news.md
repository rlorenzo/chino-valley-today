# sbcfire-news — San Bernardino County Fire news (Phase 4 Task 4.1)

Added 2026-08-17 for the daily brief's incident coverage ("what was that fire
a few blocks away"). County Fire serves unincorporated county areas and is the
regional mutual-aid presence; Chino Valley's own district is covered
separately by cvfd-news.

## Method

Standard WordPress RSS at `https://sbcfire.org/feed/`. Content: press
releases, "News Headlines" incident roundups, PIO podcast posts.

- robots.txt: an external recon tool's fetch of it was 403-blocked (2026-08-17)
  but the pipeline's own client (honest bot UA) fetches the site and feed
  normally — the block was tooling-specific, not a policy signal. politeFetch's
  mechanical robots evaluation governs, as everywhere.
- The feed carries full article HTML in `content:encoded` alongside the
  `<description>` teaser. parseRssItems() doesn't surface namespaced children,
  so the scraper reads `content:encoded` from the raw parsed XML itself
  (`contentEncodedByGuid()`); `meta.bodyIsFullText` records which path fed the
  body. First run: 10/10 items carried full text.

## Item design

- `item_type` `news_release`, `external_id` = RSS guid, `source_url` = the
  item's stable slug permalink (e.g. `/news-headlines-07-21-2026/`).
- County-wide source: `meta.chinoRelevant` flags items matching
  /chino( hills)?/i in title+body; nothing filtered at ingest — a regional
  major-incident release can matter to Chino readers without naming the city,
  and inclusion is the brief assembler's decision.

## First run (2026-08-17)

10 items, all with working permalinks and full text. Scheduled `frequent`
(hourly) — incident news is the time-sensitive half of this source's value.
