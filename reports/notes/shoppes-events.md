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
