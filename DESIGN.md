---
name: Chino Valley Today
description: A graded public record — an inspection stamp marks every sourced claim.
colors:
  crate: "#143a72"
  crate-deep: "#0d2851"
  crate-line: "#2b5391"
  stamp: "#5b2d8e"
  stamp-soft: "#efe9f7"
  placard: "#f2b705"
  oxide: "#9c2a1e"
  galv: "#f1f2f0"
  galv-sunk: "#e4e6e2"
  galv-edge: "#cdd0cb"
  stencil: "#16150f"
  muted: "#5d6058"
  on-crate: "#ffffff"
  on-crate-quiet: "#cdd8ec"
typography:
  masthead:
    fontFamily: "Archivo Narrow, Arial Narrow, sans-serif"
    fontSize: "clamp(1.5rem, 1.1rem + 2.2vw, 2.5rem)"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "0.02em"
  mark:
    fontFamily: "Archivo Narrow, Arial Narrow, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.06em"
  title:
    fontFamily: "Literata, Georgia, Times New Roman, serif"
    fontSize: "clamp(1.6rem, 1.2rem + 2.1vw, 2.6rem)"
    fontWeight: 600
    lineHeight: 1.14
    letterSpacing: "-0.006em"
  body:
    fontFamily: "Literata, Georgia, Times New Roman, serif"
    fontSize: "clamp(1.02rem, 0.98rem + 0.2vw, 1.12rem)"
    fontWeight: 400
    lineHeight: 1.62
    letterSpacing: "normal"
rounded:
  none: "0"
spacing:
  gutter: "clamp(1.15rem, 4vw, 2.5rem)"
  measure: "34rem"
  shell: "68rem"
components:
  stamp:
    textColor: "{colors.stamp}"
    typography: "{typography.mark}"
    rounded: "{rounded.none}"
    padding: "0.1em 0.42em 0.06em"
  stamp-hover:
    backgroundColor: "{colors.stamp}"
    textColor: "{colors.on-crate}"
  chip:
    textColor: "{colors.crate}"
    typography: "{typography.mark}"
    rounded: "{rounded.none}"
    padding: "0.06em 0.4em"
  chip-hover:
    backgroundColor: "{colors.crate}"
    textColor: "{colors.on-crate}"
  chip-tier-c:
    textColor: "{colors.oxide}"
    typography: "{typography.mark}"
    rounded: "{rounded.none}"
  markcard:
    backgroundColor: "{colors.crate}"
    textColor: "{colors.on-crate}"
    rounded: "{rounded.none}"
    padding: "1rem 1rem 0.85rem"
  markcard-hover:
    backgroundColor: "{colors.crate-deep}"
---

# Design System: Chino Valley Today

## Overview

The world is **Dairy Inspection Mark**. Chino Valley named a dairy preserve
before it named subdivisions, and that world's working graphic system — stencilled
crate lettering, Grade A placards, lot codes, and the violet ink of an inspection
stamp — is the source.

It was chosen for a functional reason, not an atmospheric one: an inspection stamp
records **who checked, when, and against what standard**, which is exactly what a
citation does. The product's whole claim is that every published statement is
traceable to a primary public record, so the system makes that mechanism visible
rather than describing it.

The surface is a **Read** surface. It serves a resident skimming for two minutes
and an insider verifying a citation, from one artifact, and neither may be
optimised at the other's expense.

**Redirected 2026-08-17:** the site now leads with a **daily brief** — "what do
I need to know today" — rather than with the archive. The world does not
change; the composition does. The record remains the citable spine, one level
down from the front page. An inspection stamp on this morning's fire item means
exactly what it means on a three-week-old recap.

## Colors

**Strategy: Committed.** Crate blue owns whole regions — masthead, page headers,
topic marks, footer — rather than appearing as an accent on a neutral ground. The
reading column sits on galvanised zinc.

- **Crate blue** `#143a72` is the field colour. `crate-deep` for hover and the
  footer, `crate-line` for seams between crate surfaces.
- **Galvanised zinc** `#f1f2f0` is the reading ground. It is deliberately *cool*.
  This world is steel and plastic; a warm cream ground would be the category
  default wearing the subject's clothes, and is out of system.
- **Placard yellow** `#f2b705` is wayfinding only: the rule under every crate
  field, nav underlines, counts, and focus rings on dark grounds.
- **Oxide** `#9c2a1e` marks Tier C — content a human cleared by hand — and
  unresolved placeholders. Never ambient. **Extended 2026-08-25** to the
  stale-copy notice on an archive page (`/source/<sha256>/`): those pages
  reproduce another body's document, including live safety text, and the notice
  saying so is the same claim on a reader as a Tier C mark — do not trust this
  without looking. It is the palette's only warning ink and this is a warning;
  the alternative was under-weighting it in crate.

### The one rule with teeth

**Violet `#5b2d8e` appears nowhere except where a claim is sourced.** Not on a
heading, not as an accent, not on a focus ring. If it is violet, it is provenance.
This is the system's single load-bearing constraint; everything else is
negotiable and this is not.

Applied to: the `stamp` component, every outbound link inside post prose that
cites a primary record, and the inspection-record disclosure that lists a
post's sources.

Explicitly excluded (ruling 2026-08-17, with the "headlines elsewhere"
section): links to secondary press are **attribution, not provenance**, and
never wear violet. They take a crate-outline treatment that names the outlet.
If violet ever marks a Champion or Daily Bulletin link, the one rule with teeth
has lost them.

Contrast, measured against the grounds actually used: violet on zinc 8.46:1,
white on crate 11.18:1, placard on crate 6.15:1, muted on zinc 5.70:1. All AA.
Placard on zinc is 1.62:1 and must never be used for text or focus.

## Typography

Two faces, self-hosted as variable woff2 (~104KB total, no third-party request).

- **Archivo Narrow** carries every *mark*: labels, counts, codes, dates, nav,
  masthead. Uppercase, 700, tracked `0.06em`. It stands in for crate stencil
  lettering — an adaptation, recorded honestly: a true stencil face with cut
  bridges degrades at UI sizes, which a Read surface cannot afford.
- **Literata** carries all reading matter: post prose, entry titles, blurbs. It is
  a screen reading face, chosen specifically to avoid the editorial-broadsheet
  register that a "civic record" brief summons by default.

Type is separated by *job*, not by level: anything that is a record annotation is
Archivo Narrow uppercase; anything a person reads in sentences is Literata. The
`.mark` class is the system's mechanism for this and should be reused rather than
re-specified.

`font-variant-numeric: tabular-nums` is global — dates, counts, licence numbers
and lot codes all align in columns.

## Layout

- **Shell** `68rem` for record and index surfaces; **measure** `34rem` for reading.
  Prose never runs to shell width.
- **Gutter** `clamp(1.15rem, 4vw, 2.5rem)`, shared by every container.
- **The index leads with today** (2026-08-17): the current daily brief —
  weather line, overnight incidents, today's schedule, fresh record items,
  headlines elsewhere — then the week ahead, then the record. Topic marks and
  the dated record move below the fold or to a record page; the archive is
  demoted in position, never in fidelity.
- The record is a **list, not a card grid.** Entries are `7.5rem` date column plus
  flexible title, collapsing to a single column below `40rem`. Density is the
  point: a record that paginates into cards hides how much of it there is.
- Topic marks are an auto-fit grid, `minmax(11rem, 1fr)`, seamed with `2px` of
  `crate-line`. They are navigation, not content containers.

## Elevation & Depth

There is none, by decision. No shadows, no blur, no layering. Depth in this world
comes from **field against field** — a saturated crate plane meeting a zinc plane,
divided by a placard rule. Adding a shadow would import a different world's depth
model.

## Shapes

**Radius is `0` everywhere.** Stencil lettering is cut, not drawn, and the crate,
the placard and the stamp are all square-edged objects. A `--radius` token exists
holding `0` so that nothing softens by accident.

The single exception is the stamp's leading dot (`border-radius: 50%` on a
`0.42em` square), which is the stamp's ink ring, not a rounded container.

Borders are `1.5px` on stamps and chips, `2px` on section rules and crate seams,
`6px` on the placard rule under a crate field. Hairlines below 1px are not used.

## Components

- **`.stamp`** — the system's signature. Square-cut violet outline, ink-ring dot,
  Archivo Narrow uppercase, showing the *host* it was checked against
  (`abc.ca.gov`), never the word "source" alone: a stamp naming its authority
  tells a reader something, a generic one does not. Inverts to violet fill on
  hover and focus. As a link in prose; as a non-interactive label in list rows,
  where the links live on the post itself.
- **`.chip`** — topic and status marks. Crate outline, square, inverts on hover.
  `chip--c` swaps to oxide for Tier C. Never violet: a topic is not provenance.
- **`.markcard`** — a topic face on the index. Carries a real item count and a real
  last-inspected date; an empty topic reads "0 items · none yet" rather than being
  hidden, because an empty shelf is information in a record.
- **Inspection record** — a native `<details>` holding the full source list as a
  numbered register with ledger rules. Zero JS, keyboard operable, and in-page
  searchable when open. This is the "deep on demand" half of the provenance model;
  the prose above it stays clean. A row whose citation points at an archive page
  keeps the ISSUING BODY on its stamp face and carries a muted "archived copy"
  marker beside it — a stamp reading `chinovalley.today` would say we are our
  own authority, which is the provenance inflation this component exists to
  prevent.
- **Archive page** (`/source/<sha256>/`, added 2026-08-25) — the document a post
  was built from, rendered for a person. Crate header like any record page, an
  oxide stale-copy notice above everything, then the document itself, then a
  violet provenance block carrying the fetch time and the sha256 that names the
  bytes. The contents list is crate: navigation is not provenance.
- **Focus ring** — `3px` solid, `2px` offset, stencil black on light grounds and
  placard yellow on crate fields. Deliberately not violet; see Do's and Don'ts.

## Do's and Don'ts

### Do

- Reserve violet for provenance, absolutely. A new component that needs "an accent"
  takes crate or placard.
- Reuse `.mark` for any record annotation instead of respecifying uppercase
  tracking per component.
- Show real counts, real dates, and honest zeroes. The site launched 2026-08-17
  with no known readership; nothing may imply an audience, subscribers, or a
  track record. A daily brief on a quiet day says so plainly rather than
  padding.
- Keep corners square and depth flat when adding surfaces.

### Don't

- Don't put violet on a focus ring, a heading, a hover state, or an icon. A focus
  ring lands on every link on the page and would dissolve the rule within a
  keyboard tab or two — this was an actual defect in the first build.
- Don't introduce a warm cream or paper ground. The zinc is cool on purpose.
- Don't add card grids for content or hero images. No subscribe bar until a
  real newsletter exists (Phase 3); when it does, it is one quiet crate field
  with an honest label, never a modal or interstitial.
- Don't call a recap "minutes" anywhere in chrome, copy, or metadata. Official
  minutes are a legal record adopted by the body; this is not that.

---

*Not canonized:* the build ships **no material texture** — the world names HDPE,
galvanised steel, kraft and ink, and the surface renders as flat colour. That gap
is recorded as an open finding, not as a "flat by design" rule, because writing it
into the system would legitimize a shortfall as a decision. Faking it with CSS
bevels or embossing would be worse and is banned above. The `chip--c` oxide path is
likewise coded but has never rendered — no Tier C post exists yet — so treat its
values as unproven rather than confirmed.
