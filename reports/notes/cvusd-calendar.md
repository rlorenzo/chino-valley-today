# cvusd-calendar — CVUSD district and high school calendars

Status date: 2026-09-04. Built after a museums-and-arts source survey turned up
a better target than any museum: the school district's own calendars, which are
where local performing arts actually live.

## Why this source matters

Before this, the brief had no way to know that Ayala's Madrigal Feast runs four
nights in December, or that Don Lugo stages a Fall Theater Production over three
nights in November. School concerts and plays are among the best-attended public
events in either city and none of them appeared anywhere in the pipeline.

First run, 2026-09-04, across the 2026-09-03..2027-01-02 window:

| Calendar | id | host | stored |
| --- | --- | --- | --- |
| District | 134999 | `www.chino.k12.ca.us` | 41 of 45 |
| Chino High | 135000 | `chinohigh.chino.k12.ca.us` | 13 |
| Don Antonio Lugo | 135001 | `donlugo.chino.k12.ca.us` | 55 |
| Ruben S. Ayala | 135002 | `ayala.chino.k12.ca.us` | 38 |
| Chino Hills | 135003 | `chinohills.chino.k12.ca.us` | 0 (see below) |

Arts titles surfaced on that run: Music in Motion (Oct 10), Madrigal Feast
(Dec 3, 4, 5 matinee, 5 evening), Jazz Music Concert (Dec 9), Winter Music
Concert (Dec 10), ITS Showcase (Dec 15), Fall Theater Production (Nov 5, 6, 7).

## Endpoint discovery

This is the part worth recording, because the obvious approaches all fail.

The district runs ParentSquare's **SmartSites** CMS. Its calendar page at
`/47439` returns 166KB of HTML containing an **empty** container:

```html
<div id="full-page-calendar134999" class="calendarDisplay" data-calendar="134999"></div>
```

No event titles, no dates. The page populates client-side, so the served markup
is worthless and the source was previously written off as "JS-rendered, hard".

Every feed convention was probed and none exists:

| Path | Result |
| --- | --- |
| `/rss`, `/feed`, `/site/RSS.aspx` | 404 |
| `/ical`, `/calendar.ics`, `/events.ics` | 404 |
| `/api/calendar`, `/api/events`, `/services/calendar` | 404 |
| `/47439?rss=1` | 400 |
| `/calendar/feed` | 302 to a login |

The working endpoint came from reading the page's **own bundled JavaScript**
(`/dist/assets/EventsRepository-*.js`, first-party, served from
chino.k12.ca.us), which builds the call literally:

```text
GET https://<host>/api/calendars/<calendarApiId>/events
      ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&view_source=event-slider
```

It needs no auth, no cookie and no token, and returns
`{ success: true, data: { events: [...] } }`. `view_source` accepts any string.

**There is no public ParentSquare API.** Searching for one finds only the
parent-facing app and an authenticated Aeries/SIS integration. This endpoint is
the district's own domain serving its own CMS backend, and the same shape works
unchanged on every school subdomain.

Calendar ids come from each site's own `data-calendar="…"` attribute or its
`/page/page_calendar?calID=…` link.

## Event shape

20 fields per event. The ones that matter:

```json
{
  "id": "1282187",
  "title": "Madrigal Feast (MPR)",
  "start_date": "2026-12-03",
  "start_datetime": "2026-12-03T19:00:00-08:00",
  "all_day": false,
  "address": "",
  "link": "/event_view?event_id=1282187&calIDref=135002&eventDate=2026-12-03&feed_type=ss"
}
```

**Timezones are already correct.** `start_datetime` carries a real DST-aware
offset: `-07:00` for a September event, `-08:00` for a December one. Timed
events are therefore trusted verbatim and need no conversion. All-day events
instead give a bare `"2026-09-07"`, which is resolved to LA midnight via the
shared `laOffsetMinutes` helper — storing UTC midnight would put a morning event
on the previous calendar day for every reader in Chino.

## Three decisions worth knowing

**Board meetings are dropped from the district calendar.** `cvusd-board`
already ingests every Board of Education meeting from the board's own listing,
with agenda, minutes and video attached. The district calendar repeats them as
plain events, so ingesting both would show one meeting twice in a brief, once
as a meeting and once as an event. Dropped at ingest, district only, via the
`dropBoardMeetings` config flag. School-site board presentations are
deliberately not matched.

**An empty calendar is a note, not a failure.** Chino Hills High (135003) was
valid and live but returned zero events for the fall on 2026-09-04; a full-year
query returned 31 events that stop at 2026-08-10, so the school had simply not
posted its fall calendar yet. Only *every* calendar failing at once throws,
because that is what an API change looks like. Worth re-checking Chino Hills
later in the semester.

**Multi-day spans arrive one row per day.** The API expands "Winter Break" into
roughly 20 separate events sharing a single `source_url` and differing only in
`start_date`. They are stored as distinct items (the external_id is
`<id>:<start_date>`) and dedupe to one per day in `selectTodayEvents`, so the
brief reads correctly while the archive stays chattier than you might expect.

## Politeness

`robots.txt` on the district and every school subdomain disallows only
`/admin`, `/*lesson_plan` and `/userFiles`, and asks `Crawl-delay: 5`. `/api/`
is unrestricted. politeFetch enforces 2s per host; this scraper adds 3s more
between calendars to reach the full 5s. The delay is applied between all
requests rather than per host, because five subdomains are still one server and
one operator.

The district's asset host `files.smartsites.parentsquare.com` is
`User-agent: * / Disallow: /` (only Googlebot-Image is allowed) and is never
touched by this scraper.

## Open questions

- Long-term stability of the calendar ids. They are data values rather than
  content-hashed asset names, so they should survive a deploy, but this is
  unproven over time. A changed id shows up as a calendar that returns nothing
  while the others keep working.
- Pagination and range limits were not probed beyond a 4-month window.
- Whether middle and elementary schools expose the same endpoint. The pattern
  almost certainly holds; only the four comprehensive high schools are ingested
  because those are the ones with public performances.
