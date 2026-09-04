# planesoffame-events — Planes of Fame Air Museum

Status date: 2026-09-04. Built after a survey of museums, galleries and arts
organizations serving Chino and Chino Hills, prompted by the observation that
the Chino Youth Museum never appears in the brief. That survey is summarized at
the bottom, because the negative results are the reason this is the only new
calendar source it produced.

## The source

Planes of Fame Air Museum, 7000 Merrill Ave, Chino (Chino Airport) — the second
warbird museum at that airport, next to the already-ingested Yanks Air Museum.

Public programming is a monthly **Hangar Talk** series (a talk plus a flight of
one aircraft, Saturdays at 10:30am), occasional special-flight days when a
visiting aircraft is on the ramp, and appearances at other people's airshows.

## Endpoint discovery

There is no API and no feed. Probed 2026-09-04:

- `/wp-json/` → 404. `/wp-json/tribe/events/v1/events` → 404. Not WordPress, so
  the `tribe-events.ts` core that serves the other four calendars is unusable.
- No `.ics`, no `/feed`, no RSS `<link rel="alternate">` anywhere on the site.
- The site runs a small custom/agency CMS (`base.css`, `theme.css`, `/assets/`,
  a canonical `error404` page). No vendor fingerprint worth recording.

What it does have is `https://planesoffame.org/events-calendar`: 85KB of
server-rendered HTML, five event blocks on the probe day, each with a real
permalink. That is the only machine-readable surface and it is enough.

## Markup contract

```html
<div class="nice-shadow relative mx2 my3 p2 ">
  <div class="bold center mb1">5<sup>th</sup> of September, 2026</div>
  <a href="https://planesoffame.org/events-calendar2/Hangar-Talk-8"
     class="block h3 second-font navy text-decoration-none">TITLE</a>
  <div class="clearfix">
    <div class="overflow-hidden"><p><p>BODY PROSE</p></p></div>
  </div>
</div>
```

`.nice-shadow` appeared exactly 5 times on the probe day, all of them event
blocks — it is not used for other page furniture. A block missing a date, a
title or an href is skipped rather than half-stored; zero blocks overall throws.

## Two things the markup does not give you

**No start time.** The header div is date-only. Times live in the body prose:
"Special Flights … Saturday, September 5, 2026 at 10:30am." `extractTime` pulls
the first `at <h>[:mm]<am|pm>` out of the blurb and the event is stored
`allDay` when the prose has none. This is a heuristic over prose written by a
human, so it will occasionally miss; missing degrades to all-day, which is the
safe direction.

**Off-site events are mixed in with local ones.** "Central Coast AirFest,
September 12-13, 2026, Santa Maria, CA" sits in the same list as the Chino
Hangar Talks, with its anchor pointing at `centralcoastairfest.com`. Detection
is structural rather than textual: an anchor whose host is not
`planesoffame.org` is an appearance somewhere else. Those are ingested whole
(the archive stays complete) and flagged `meta.offsite`; `isRenderableEvent` in
`src/pipeline/daily-brief.ts` drops flagged rows from the Today section.

## Timezone

Listing times are Chino-area wall clock. Conversion reuses
`localDateTimeToIso` from `civicplus-rss.ts` rather than re-deriving the
offset, so the PDT/PST boundary is correct: the live run stored Oct 3 10:30 as
`17:30Z` and Nov 7 10:30 as `18:30Z`, on either side of the Nov 1 change.

## robots.txt (fetched 2026-09-04)

```text
User-agent: *
Disallow: /doc/ /install/ /lib/ /modules/ /module_custom/ /plugins/ /scripts/ /tmp/ /assets/
Allow:    /assets/sitemaps/ /assets/css/ /assets/images/ /assets/themes/ /tmp/cache/
Sitemap:  https://planesoffame.org/sitemap.xml
```

`/events-calendar` is not covered by any rule. Nothing this scraper fetches is
disallowed and no skip flag is used anywhere in it.

## First live run (2026-09-04)

5 documents/items: 5 of 5 blocks parsed, 1 off-site, 1 all-day. 773ms.

---

## Survey context: why this is the only new museum/arts source

**Chino Youth Museum — no ingestible source exists.** Its `robots.txt`
disallows every page that carries program dates by name (`/summer-programs.html`,
`/fall-programs.html`, `/winter-programs.html`, `/spring-programs.html`, the two
5K pages, `/easter-bunny-extravaganza.html`, `/cym-lab-virtual.html`). The two
program pages that *are* allowed publish their content as **images**
(`september-2026-around-the-world-calendar-1_orig.png`); the only extractable
sentence on the whole site is "*No First Friday CYM Lab in March, July, or
December." Its Mailchimp newsletter archive is public
(`us3.campaign-archive.com/feed?u=f8dbe2ab7ac053d83e0acad42&id=4a89a7c5d7`,
campaigns sent under `mailchi.mp/cityofchino/…`) and carries a real RSS feed,
but **both Mailchimp hosts are `User-agent: * / Disallow: /`**, so HTTP
retrieval is off the table. The newsletters are themselves image-only: 11
images, no alt text, body text limited to button labels. The remaining paths
are the Nixle precedent (subscribe a mailbox, read over IMAP, cite the
`mailchi.mp` permalink), which solves permission but not the image problem, or
asking the museum to publish dates as text.

**Chino Valley Historical Society / Old Schoolhouse Museum** — 2 signature
events a year, Weebly, no feed. Not worth a scraper.

**Yanks Air Museum** — already ingested (`yanksair-events`).

**Nothing else qualifies.** No Chino Hills Historical Society exists as a
distinct organization; no standalone dairy or railroad museum exists (that
heritage lives inside CVHS); Boys Republic reduces to one annual car show.
Chino Hills Community Foundation runs a working Tribe endpoint
(`chinohillsfoundation.com`, robots fully open) but it currently holds only two
board meetings whose titles are bare dates.

**Deliberately declined:** Lewis Family Playhouse (Rancho Cucamonga) has the
highest event volume found anywhere in the survey and a parseable
server-rendered listing, but it is outside the coverage area and its robots.txt
carries `Disallow: /` scoped to `User-agent: GPTBot`. Declined 2026-09-04 on
the user's call.
