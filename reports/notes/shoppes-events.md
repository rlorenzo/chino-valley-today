# shoppes-events — The Shops at Chino Hills — REJECTED on ToS (2026-09-19)

Probed at the operator's request ("can we import events from
<https://www.shoppesatchinohills.com>"). The answer is no, and the reason is
the terms, not the markup. Recording the whole probe anyway, because the
mechanical half of it is genuinely good news and someone will ask again.

## What the site is

`shoppesatchinohills.com` is a Next.js site on **Placewise** (the mall CMS;
assets served from `cdn.sites.us.placewise.com`), owned by Stockdale Capital
Partners and operated by Placewise LLC. The property now brands itself **The
Shops at Chino Hills** — the domain still says "Shoppes", the content does not.
Note that when writing anything reader-facing; `src/gates/allowlists.ts` still
carries only the "Shoppes" spellings.

## Mechanically: easier than PRODUCT.md assumed

PRODUCT.md lists this under "the JS-rendered calendars", grouped with CVUSD and
Chaffey as needing something we do not have. That is wrong, and worth fixing
even though the source is rejected: **the events are server-rendered into the
SSG payload.** No headless browser is needed.

- `GET /events` returns 216 KB of HTML with a `<script id="__NEXT_DATA__">`
  block. `props.pageProps.sectionsData.events_list_container.events[]` is the
  full event list as JSON — id, title, slug, permalink path, HTML body,
  headline, location, `occurrence_type`, and UTC `starts_at` / `ends_at`.
- Per-event pages (`/event/43307-farmers-market`) carry the same object under
  `sectionsData.event_container`, plus a schema.org `Event` with the venue
  address (13920 City Center Drive, Chino Hills, CA 91709).
- `GET /sitemap.xml` is real XML, 248 `<loc>`s, with one entry per event —
  discovery would not even need the listing page.
- Five events on the probe day, in two shapes: `time_range` (the dated
  one-offs — 15th Annual Chino Hills Wine Walk, CAACH Moon Festival) and
  `date_range` with a null `end_date` (the standing attractions — Heritage
  Farmers Market, Downtown Art Gallery, Wetzel's Pretzel Express). A scraper
  would have had to treat the second shape as ongoing rather than as a
  one-day event starting 2026-09-02.

## robots.txt: there isn't one

`GET /robots.txt` returns **HTTP 200 with the SPA shell** — byte-identical
(4,248 bytes, verified with `cmp`) to what `/event` returns, which is the
catch-all for a path that does not exist. So there is no robots.txt, and our
parser would read the HTML as zero groups and allow everything.

That is exactly the trap the KTLA decision was written for. A missing
robots.txt is not permission; it is the absence of one of the two gates. The
other gate is the terms, and the terms are dispositive.

## Terms of Use: a direct prohibition

<https://www.shoppesatchinohills.com/terms> (page id 21693, "Terms of Use",
effective date January 26, 2026; fetched 2026-09-19, raw-byte sha256
`bbaae6bf0fed66a53f58542cf09bd7e56c2dc54ac91e41871ea348a0a1d0d3f0` — recorded
for the trail only, not registered in `tos-config.ts`, since a rejected source
has nothing to drift-check). The text is served inside `__NEXT_DATA__` under
`props.pageProps.page.sections[].component.text`, not as page markup.

> You may not use spiders, robots, data mining techniques or other automated
> devices or programs to catalog, download or otherwise reproduce, store or
> distribute content available on the Site.

And, on the content itself:

> none of this Content may be used, copied, reproduced, distributed,
> republished, downloaded, modified, displayed, posted or transmitted in any
> form or by any means … without our express prior written permission.
> Permission is hereby granted … for your personal, educational, noncommercial
> use only, provided that you (i) do not modify the Content; (ii) you retain
> any and all copyright and other proprietary notices …; and (iii) you do not
> copy or post the Content on any network computer or broadcast the Content in
> any media.

The first clause alone decides it. A scraper is a robot that catalogs,
downloads and stores content — all four verbs, in one sentence, in that order.
This is the Nixle / KTLA / Champion class: a binding ToS prohibition on
automated ingestion of any kind, and it binds regardless of robots posture.

The second clause forecloses the usual fallback. "We only link, we never
republish" does not help here for the same reason it did not help the Champion
(EDITORIAL.md, 2026-08-26): the prohibition is on *access and storage*, so
fetching the page is itself the prohibited act, and our content-addressed raw
archive is precisely the "copy … on any network computer" the grant excludes.
A daily brief is also not personal noncommercial use.

## "What if we only publish a title and a link?" (asked 2026-09-19)

The first question back, and it splits in two. The answer differs depending on
who does the fetching, which is the whole point of the Champion rule.

**Automated, publishing only a title and a link — still no.** The robot clause
governs the *fetch*, not the publication: using a program to "catalog,
download or otherwise reproduce, store" the Site's content is the prohibited
act, and our pipeline would do all three before deciding what to render. Both
halves of the pipeline trip it independently — `fetchDocument` writes a
content-addressed copy of the page into the raw archive, and `insertItem`
stores the title as a row. Publishing nothing at all would not cure it. This
is the same answer EDITORIAL.md already gives for the Champion, and it does
not change with how little we render.

**A human reading the page and typing a line by hand — different question,
and much narrower.** No spider, no robot, no automated device, so the clause
that decides the automated case simply does not reach it. Three things are
worth separating:

- **Linking is unrestricted.** The terms contain no linking clause at all —
  the only `LINKS` section is `LINKS TO THIRD-PARTY WEBSITES`, which is about
  links *from* their site *to* others, and disclaims responsibility rather
  than granting or withholding anything. Every section heading was read to
  confirm this. That is a weaker position than the Champion, whose terms
  expressly grant linking and reserve the right to revoke it; here there is
  nothing to revoke because there is nothing addressed.
- **The facts are ours to state.** That an event happens, on a date, at a
  time, at a place, is not anyone's property. A line written in our own words
  and pointed at their page is not reproduction of their Content.
- **Their wording is the one edge.** `DEFINITIONS` makes "Content" cover "all
  of the text … available on this Site", and the grant that follows is for
  "personal, educational, noncommercial use only" with a proviso that you "do
  not copy or post the Content on any network computer". Read literally, an
  event title lifted verbatim onto chinovalley.today is text from the Site on
  a network computer. Whether a short factual title is protectable at all is a
  separate question from what their contract says, and this note does not
  answer it — it flags it. Writing our own title avoids needing to know.

So a hand-maintained line, in our own words, linking their event page, is a
defensible reading of these terms where an automated one is not. **It is still
the wrong build.** It puts a recurring manual task on an operator the project
is designed not to require, for a venue that posts a handful of real events a
year — and it buys nothing over the option below, which needs no such reading.

This is not legal advice, and the call is the operator's.

## Where the events are still reachable

Rejecting the mall's site does not mean losing the events. Every one of the
five has an organizer of its own, and the two that matter are already better
sourced:

- **Heritage Farmers Market** is already in the brief, cited to
  `heritagefarmersmarket.org/chino-hills` (`FARMERS_MARKET_URL` in
  `src/pipeline/daily-brief.ts`). Nothing changes.
- **Chino Hills Wine Walk** is a Chino Hills Community Foundation event —
  `chinohillsfoundation.com`, whose robots.txt is fully open
  (`User-Agent: *` / empty `Disallow:`). The mall is the venue, not the
  publisher. Terms not yet read; that read is the prerequisite if anyone
  wants this as a source.
- **CAACH Moon Festival** is a Chinese American Association of Chino Hills
  event, likewise published by the organizer.
- **The mall's own listings point at both.** The Wine Walk body links
  `chinohillsfoundation.com/wine-walk-2026/` and the Moon Festival body links
  `caach.org` — the property is telling readers to go to the organizer for
  the event itself. Following that is not a workaround; it is the deeper and
  more durable link, the one that survives the mall rotating its calendar,
  and the one whose publisher can issue a correction.
- The city's own CivicPlus calendar (`chinohills-news-rss`, already ingested)
  carries community events held at the property when the city is involved.

The standing attractions (art gallery, pretzel train) are mall amenities
rather than dated events, and are not brief material in any case.

## Follow-on: chinohillsfoundation.com, checked 2026-09-19

Checked because the section above recommends it, and the Champion is the
reason we read terms *before* building rather than after.

**Access posture is clean — cleaner than most sources already ingested.**

- `robots.txt` is `User-Agent: *` with an empty `Disallow:`. Nothing
  restricted, no `Crawl-delay`, no AI-crawler carve-outs.
- **There is no terms of use page, and no privacy policy.** Ten common paths
  probed (`/terms`, `/terms-of-use`, `/terms-of-service`, `/privacy`,
  `/privacy-policy`, `/legal`, `/disclaimer`, `/copyright`, …) all 404 or are
  not real pages, and the Yoast sitemap index was enumerated in full — 64
  pages across `page`, `service`, `footer` and `ct-mega-menu` sitemaps, not
  one of them legal. The footer carries a bare
  "© Chino Hills Community Foundation. All rights reserved." and no legal
  links at all.
- A bare copyright notice is the default state of every website. It asserts
  copyright; it is not an access restriction, not a contract, and it does not
  reach facts or inbound links. So **robots.txt is the binding access
  document** — the treatment `tos-config.ts` already applies to CIF-SS, the
  three Home Campus sites and the SNO student papers, with the same
  justification recorded in each of their notes.
- **One wrinkle worth recording: a Sucuri CloudProxy WAF sits in front.**
  `/legal` and `/terms-and-conditions` returned HTTP 307 JS challenges rather
  than 404s (the challenge is what 307s, not a page). Ordinary paths, all
  sitemaps and the REST API returned clean, so nothing is blocked today — but
  a WAF can start challenging a bot UA at any time, which is a reliability
  note, not a permission one. `failClosedRobots: true` and the usual degraded-
  source alarm would both apply.

**But the calendar is not what we wanted, and that is the finding.**

`https://chinohillsfoundation.com/wp-json/tribe/events/v1/events` is live and
well-formed — WordPress with The Events Calendar, the same API family as
`sbclib-events` / `sbparks-events` / `cbwcd-events` / `yanksair-events`, so
`tribe-events.ts` would very likely read it unmodified. It returns **five
events, all of them board meetings** (`tribe_events-sitemap.xml` confirms
that is the whole calendar, ever; the only two categories are "Board
Meetings" and "Special Meeting"). They are held in the Chino Hills City
Council Chambers, but the Foundation is a private 501(c)(3) — no Brown Act,
not a public body. Whether a nonprofit's board schedule is brief material is
an editorial question, not a technical one, and it is not answered here.

**The Wine Walk is not in the calendar at all.** It is a hand-built Elementor
marketing page at `/wine-walk-2026/`, with no `Event` JSON-LD (Yoast emits
only `WebPage`/`Organization`/`BreadcrumbList`), the date and time in prose
("October 10, 2026 5:00 pm to 8:00 pm"), and a fresh URL each year —
`/wine-walk-2025/` is still up. Same for the concert series, home tours, jazz
festival and CHARTS: all bespoke pages, none of them calendar entries. A
scraper over those would be the most churn-prone thing in the repo, for one
event a year. That is the case the hand-maintained `FARMERS_MARKET_URL`
constant in `daily-brief.ts` already exists for.

So the Foundation is **permitted but nearly empty** of what the Shoppes
rejection sent us looking for. Recorded rather than built.

## Incidental find: the city's Calendar module is not ingested

Chased while checking whether the city already carries these events, and
worth more than the question that prompted it.

`chinohills-news-rss` ingests News & Announcements (`ModID=1`) and the Alert
Center (`ModID=63`) from `chinohills.org`. The catalog in that scraper's
header also lists **Calendar as `ModID=58`, and nothing ingests it.**

`RSSFeed.aspx?ModID=58&CID=All-calendar.xml` returns HTTP 200 and 18 items on
the probe day, with structured `calendarEvent:EventDates`,
`calendarEvent:EventTimes` and `calendarEvent:Location` fields and item-level
links (`Calendar.aspx?EID=N`). Contents are real community events — Blood
Drive, Bulky Item Drop-off, Mulch and Compost Giveaway, a horse show at McCoy
Arenas, City Council Meeting.

The full `chinohills.org` robots.txt was re-read: `/RSS.aspx` (the catalog)
is disallowed, as SOURCES.md already records, but **neither `Calendar.aspx`
nor `RSSFeed.aspx` is covered by any rule.** Same host, same permitted
endpoint family, same politeness posture as the two modules already ingested.

The Wine Walk is not in the current feed, but the window only runs to
October 3 on the probe day and the event is October 10 — so this is "outside
today's window", not "the city does not carry it". Worth re-checking nearer
the date before concluding anything.

This looks like a genuine gap: the brief has a "today's events" section, and
this is a structured, already-permitted municipal events feed on a host the
pipeline already talks to. Not built — flagged for the operator.

## If someone wants this source anyway

The terms name a contact — `webmaster@placewise.com`, and the property's
office at 13920 City Center Drive — and the copyright clause is written around
"express prior written permission". That is the same route the Champion request
took. A permission request would need to cover automated retrieval *and*
storage, not just publication, since three of the prohibited acts happen before
anything is published. If permission arrives, record it in EDITORIAL.md with
the date and the form it took, then build the scraper — the parsing work is
about a day, and this note has the shape of the data.

Until then: not built, not registered, nothing to invoke.
