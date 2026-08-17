# Phase 1, Tier A — deterministic template generators

Entry point: `node src/tiera/run.ts`. Reads the current `data/cvtoday.db` (does
not run scrapers), generates posts for all four Tier A post types, and
transitions each straight to `published` — no LLM, no human gate, per
PLAN.md/EDITORIAL.md ("a template that quotes agenda item titles verbatim
with links cannot hallucinate").

Files: `src/tiera/run.ts` (entry point), `src/tiera/{util,queries,
meeting-previews,alerts,business-tracker,news-digest}.ts`.

## What generates today, from real data (run at 2026-08-12T06:36 UTC)

| post type | posts | detail |
|---|---|---|
| meeting_preview | 3 | all from chino-news-rss's city calendar: `2026-08-18-chino-city-council-preview` (**CANCELLED**), `2026-08-19-chino-planning-commission-preview`, `2026-08-24-chino-community-services-parks-recreation-commission-preview` |
| alert | 0 | 0 active alerts — correct, see below |
| business_tracker | 1 | `2026-W33-business-tracker`, 2 license_event items |
| news_digest | 1 | `2026-W33-news-digest`, 4 news_release items (Chino Hills only this window) |

Verified: `npx tsc --noEmit` clean; two consecutive runs (`node
src/tiera/run.ts` x2) — first run: 5x `created`→`published`; second run: 5x
`skipped`, zero `created`/`updated`; `SELECT slug, COUNT(*) FROM posts GROUP
BY slug HAVING COUNT(*)>1` returns nothing. Hand-read one generated file per
post type in `content/published/` — valid frontmatter, verbatim titles,
working `[text](url)` links, disclosure footer present, no invented facts
(every Date/Time/Location line traces to an actual `meta` field; absent
fields are omitted, never guessed).

**Update 2026-08-12, same session:** added `chinohills-agendas` as a 4th
meeting-preview candidate (see "Design decisions" below for the rule and the
team-lead decision that resolved the open question originally flagged here).
Re-verified after the change: `tsc --noEmit` clean; ran `node src/tiera/run.ts`
twice more — both runs produced `chinohills-agendas: 0 upcoming meeting(s)
... -> 0 preview post(s)` (correctly — its only two meetings in the DB are
dated today and last week, neither strictly future) and left the 3 existing
meeting previews as `skipped`; still 5 total posts in `posts`, still zero
duplicate slugs.

## What produced nothing, and why

- **cvusd-board previews (0):** all 19 `event` items in the DB are in the
  past (most recent scraped meeting: 2026-07-16); no upcoming meeting to
  preview. Also, CVUSD's agenda PDF host (`files.smartsites.parentsquare.com`)
  blocks robots — even when a future cvusd-board meeting does appear, its
  preview will only ever link to the meeting/agenda page, never quote agenda
  items, until that block is lifted (see `cvusd-board.ts`). The generator
  handles this correctly (falls back to a link) rather than erroring.
- **chino-legistar previews (0):** all agenda_item rows currently in the DB
  are for past meetings (latest: 2026-07-28); Legistar simply hasn't
  published a future meeting's agenda yet as of this scrape. Code path is
  implemented and will fire the moment a future EventId with agenda items
  appears.
- **chinohills-agendas previews (0):** its 2 meetings in the DB are dated
  2026-08-11 (today — excluded by the strict future-only, same-day-never
  rule below) and 2026-08-05 (already past). Code path is implemented and
  will fire the moment a chinohills-agendas meeting dated strictly after the
  run date appears with agenda items attached.
- **alerts (0):** all 10 `alert` items in the DB are expired NWS Heat
  Advisories from Aug 6–9 (`meta.ends` all in the past relative to run
  time). Correct "quiet day" outcome per the task brief.
- **chino-news-rss contributed 0 items to the news digest this run:** its
  most recent news_release (`Over 500 Chino Valley Students...`, occurred_at
  2026-07-28T07:00Z) falls just outside the rolling 14-day window at actual
  run time — not a bug, just where the window landed. Re-running on a day
  when Chino's own feed has fresher releases will include them automatically.

## Design decisions

**Meeting-preview candidates: four, including chinohills-agendas as of
2026-08-12 (team-lead decision).** The brief originally named three
(chino-news-rss `event`, cvusd-board `event`, chino-legistar future
`agenda_item` groups). I flagged `chinohills-agendas` as an open question
rather than adding it unilaterally, because its only meeting in the DB at
the time was dated `2026-08-11` — *today*, with no time-of-day in the
source — and the run happens at 23:36 local, so that meeting had almost
certainly already occurred. Team lead's ruling: add it as a 4th candidate
with a **strict future-only rule** — preview only when the meeting's Pacific
calendar date is strictly after the run date's Pacific calendar date;
same-day meetings are never previewed (no time-of-day data means we can't
know if it already happened, and PLAN.md's previews are meant to publish
T-1 day anyway, so a same-day preview adds nothing even when correct).
`isFutureOccurredAt()` (`src/tiera/util.ts`) already implemented exactly
this rule for date-only `occurred_at` strings — used unchanged by
`genChinohillsAgendaPreviews()` in `meeting-previews.ts`, grouped by
`meta.seq` (chinohills-agendas.ts's AgendaQuick meeting sequence id, the
stable per-meeting identity for that source). Re-verified: today's DB has
exactly 2 chinohills-agendas meetings (2026-08-11 = today, 2026-08-05 =
past), so this candidate correctly contributes 0 posts right now — the code
path is exercised (it runs and evaluates both meetings) even though neither
passes the future test yet.

**Pacific-timezone-aware date handling (load-bearing correctness fix).**
chino-news-rss calendar `occurred_at` values are full UTC instants — e.g. the
CANCELLED City Council meeting is stored as `2026-08-19T01:00:00.000Z`, which
is **August 18, 6pm Pacific**. Naively slicing the UTC date would have
produced the slug/meeting_date `2026-08-19` — one day wrong, and wrong in the
title too, in the very first post generated. `localMeetingDate()`
(`src/tiera/util.ts`) converts full ISO instants to their America/Los_Angeles
calendar date via `Intl.DateTimeFormat`, while passing date-only strings
(cvusd-board, chino-agendacenter, chinohills-agendas — no time-of-day in the
source) through **unchanged**, since re-parsing those as UTC midnight and
reprojecting to Pacific would shift *them* a day in the other direction. Two
different DB fields, same column name (`occurred_at`), two genuinely
different meanings — mixing the handling would silently corrupt dates.

**"Future" test is deliberately conservative for date-only meeting dates.**
Full ISO instants compare directly against `now`. Date-only dates (no
time-of-day) only count as "future" on strictly *later* Pacific calendar
days than today — a same-day meeting with unknown time is never treated as
upcoming, since Tier A must never guess whether it already happened. This
rule is what excludes chinohills-agendas' today-dated (2026-08-11) meeting
above — this is the exact case it exists to handle, and it's now exercised
by real data every run (not just cvusd-board's already-past dates, which
never get close to the boundary).

**Slug scheme:** `<local-meeting-date>-<city-prefix>-<slugified-body>-preview`
for previews (e.g. `2026-08-20-chino-planning-commission-preview`, matching
the brief's example exactly); `<ISO-week>-business-tracker` /
`<ISO-week>-news-digest` for the two weekly rollups. ISO week is computed
from **Chino Valley's local (Pacific) calendar date**, not server/UTC time —
a run just after midnight UTC (early evening Pacific) would otherwise land
in tomorrow's ISO week from a Pacific reader's perspective.

**Active-alert logic:** an alert counts as active only if `meta.ends` (the
scraper's own `ends ?? expires` field) parses to an instant strictly after
`now`. An alert with no parseable end time is **not** treated as active —
no guessing an implicit "ongoing" state. Alert slugs append an 8-hex-char
hash of `external_id` (`<date>-<event-slug>-alert-<hash>`) since the same
alert type can recur same-day (10 alerts in the DB right now are 8 separate
Heat Advisory issuances across 3 days) and the brief didn't specify an exact
alert slug format.

**Agenda-item cross-referencing for calendar-only events.** chino-news-rss
and cvusd-board calendar `event` items carry no agenda items of their own.
For chino-news-rss events, the generator searches chino-legistar,
chino-agendacenter, and chinohills-agendas `agenda_item` rows for a match on
(local meeting date, normalized body name — substring-containment match,
e.g. "City Council" matches "City Council Regular"), and inlines the
matched titles verbatim with their own links if found, else falls back to
"No agenda had been posted to our records" + the calendar link. Currently 0
matches exist in the DB (no future meeting has a posted agenda yet), so this
path is implemented and typechecked but **not exercised against real
matching data** — worth a spot-check once a future Chino meeting's agenda
lands in Legistar before its calendar entry ages out.

**Business tracker / news digest formatting.** Every field is pulled
directly from `items.meta` (license: `primary_name`/`dba`/`license_type`/
`status`/`premises_address`; both source_urls in today's data point at the
same status-changes report page — a known abc-licenses.ts limitation
[query-string permalinks are blocked site-wide by Cloudflare], not something
this generator can fix, and it's still a real, working, non-empty URL so
`sources[]` validity holds). News digest teasers truncate `body` to ~140
chars at a word boundary; if `body` is empty, only the headline+link line is
emitted (never invented filler text).

**Markdown safety.** All DB-sourced text passed into link text or inline
body content goes through `mdEscape()` (escapes `\ \` * _ [ ]`) so a
title/body containing markdown-control characters can't alter the rendered
document's structure (e.g. break a link, or create unintended emphasis).
Block-level markdown injection (a title starting with`#`) is not defended
against — judged out of scope for a Tier A POC given real government/RSS
titles essentially never start that way; worth hardening before Phase 2 if
this generator's output is ever templated into a larger page without further
sanitization.

## Edge cases a future maintainer must know

1. **Duplicate news_release rows exist in the DB today** (item ids 145/147
   are byte-identical duplicates — same `external_id`, same `source_url`,
   different `document_id`; same for 146/148). This predates Tier A and
   looks like a scraper-run artifact from before `resolveDocumentId()`
   pinning was fully effective, or an early bootstrap run. The news digest
   generator dedupes by `source_url` (keeping the highest-`id` row) so this
   never surfaces as a doubled headline in output, but the underlying rows
   are still in `items` — worth a Phase-0-scraper follow-up, not a Tier A
   concern to fix by mutating scraped data.
2. **abc-licenses `source_url` is document-level, not per-license**, by
   design (see abc-licenses.ts's extensive comment on the Cloudflare
   query-string block) — every business_tracker entry this run links to the
   same status-changes report page. Correct per the data; don't "fix" this
   in the generator by inventing a per-license URL from
   `meta.attempted_detail_url` (it's documented as non-working).
3. **`createPost()` never updates an already-published post.** Weekly
   rollups (business_tracker, news_digest) are effectively a snapshot as of
   first-publish within that ISO week — if new abc-licenses/news_release
   items land later in the same week, re-running `run.ts` will **not**
   append them to the already-published post (outcome: `skipped`, by
   design of the shared pipeline API — "posts a human already published...
   are never clobbered by a generator"). A correction/addendum workflow
   (EDITORIAL.md's corrections policy) would be the right mechanism if this
   needs revisiting, not a Tier A code change.
4. **`documents.location` is unused by every scraper today** (always
   `NULL`) — meeting location, where available, currently only comes
   through `items.meta.location` (chino-news-rss calendar only). Previews
   from other sources have no location line, correctly, rather than a
   fabricated one.
5. **Slug collisions within a single run are defended against** (a `Set` of
   slugs seen this run; a collision logs an error and skips rather than
   silently overwriting) but none occurred in testing — theoretical
   safety net, not exercised by current data.
