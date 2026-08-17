---
version: 1
slug: "site-src-pages-index-astro"
primary_target: "site/src/pages/index.astro"
related_targets: ["site/src/pages/posts/[...slug].astro","site/src/pages/topics/[topic].astro","site/src/pages/about.astro"]
---

# Public site — scope and strategy

**Visitor mode:** Read. Every surface here (index, permalink, topic pages, About)
exists so a visitor understands what a public body actually did. It is not a
Persuade surface: there is nothing to sign up for, and the project is pre-launch
with no audience.

## Audience and job

Two readers, one artifact. A Chino or Chino Hills resident who cannot attend a
three-hour weeknight meeting and wants to know what was decided in two minutes;
and a civic insider — official, staff, commissioner, journalist — using it as a
faster, citable record. Neither may be served at the other's expense: the page
must survive a skim and a citation-check equally.

Arrival is usually issue-driven (a development near a house, a school board vote,
a licence on a block), not feed-browsing, which is why topic is the organising
spine rather than date.

## Task and structure

- **Topic is the navigation spine** (planning, cvusd, business, safety), confirmed
  with the user over by-body, by-date, and by-place.
- The index still leads with the four topic marks, then the complete dated record
  beneath. The record is the full set; topic pages are filtered views of it.
- **Provenance is layered**: prose reads clean, every sourced claim wears a stamp
  inline, and the full inspection record opens on demand in a native `<details>`
  (zero JS, keyboard operable, in-page-searchable when open).

## Proof and content

Real content only. Nine published posts drawn from the pipeline's own
`content/published/`; the site renders the corpus, it does not own or copy it.
Counts, dates and source authorities on the page are computed from that corpus,
so an empty topic honestly reads "0 items · none yet".

**No invented proof.** Pre-launch with zero readers: no metrics, no subscriber
counts, no testimonials, no "trusted by", no subscribe bar.

## Constraints

- Zero client JS by default. One runtime maximum if a widget ever earns it.
- The content-collection schema mirrors `renderPostFile()` exactly and is the
  last-line validator after Gate 1 and Gate 2: a malformed post fails the build.
  `sources` is `.nonempty()` because "no source, no claim" is an editorial rule,
  not a nicety.
- Only `content/published/` is built. Queue, held and rejected are working state
  and must never reach the public site.
- Recaps are never called "minutes" anywhere in chrome or copy.
- Site origin is a single config value: ships to an interim subdomain, moves to
  the branded domain in one line.

## Chosen direction and memorable moment

**Dairy Inspection Mark** (seed 29a604d7). The memorable moment is the rule, not
an animation: **violet inspection ink appears nowhere except on a sourced claim.**
Scanning the index, every row visibly carries the authority it rests on; reading a
post, every sourced sentence ends in a stamp you can follow. The mechanism is
legible without the page ever explaining itself.

## Unresolved

- **Topics are derived site-side** (`lib/record.ts` `topicsFor`) from post_type
  plus title keywords, because the pipeline emits no topic field. Deliberately
  conservative — a post is filed only on unambiguous evidence — so several council
  items are untagged and topic pages are thin. This belongs in the pipeline, which
  owns the source keys and item types that would classify far more accurately.
- **No corrections contact and no About copy exist.** About ships a marked
  placeholder; the post footer already points readers there, so this blocks launch.
- **No accessibility standard has been set** for the project (recorded in
  PRODUCT.md). The build holds a sensible floor — visible focus, real landmarks,
  a skip link, native disclosure — but no target has been agreed.
