---
version: 2
slug: "site-src-pages-index-astro"
primary_target: "site/src/pages/index.astro"
related_targets: ["site/src/pages/posts/[...slug].astro","site/src/pages/topics/[topic].astro","site/src/pages/about.astro"]
---

# Public site — scope and strategy

**Visitor mode:** Read. Every surface here exists so a visitor understands what
is happening in Chino Valley and what public bodies actually did. Still not a
Persuade surface: nothing is sold, and no audience may be implied.

**Version 2 (2026-08-17): daily-brief redirection.** Version 1 built a
record-led index (topic marks, then the full dated archive). That composition
is superseded — see "Critique of v1" below — but its provenance system, record
list, and topic pages all survive one level down.

## Audience and job

Three readers, one artifact:

- The **morning-habit reader**: checks daily like a weather app. Wants "what do
  I need to know today" answered in two minutes — weather, overnight incidents,
  today's meetings and events, anything fresh.
- The **issue/incident-driven arriver**: saw smoke yesterday, heard about a
  vote, got a Nixle push. Lands wanting "what was that about," today or from
  the recent past.
- The **civic insider**: uses it as a faster, citable record. The archive and
  inspection stamps serve them; nothing about the daily brief may degrade
  citability.

## Critique of v1 (why the record-led index failed the product)

Recorded so the rebuild answers each point rather than rediscovering them:

1. **No answer to "today."** The index was an archive — a filing cabinet, not a
   front page. A resident arriving after seeing smoke got a list of council
   recaps.
2. **Recency was flattened.** A three-week-old recap and this morning's alert
   ranked identically; nothing on the page changed daily, fatal for a brand
   named chinovalley**.today**.
3. **No ambient layer.** No weather, no "this week," nothing to anchor a habit.
   Tucson Daily Brief's loop is "check every morning"; v1 gave a reason to
   check 8–12 times a month.
4. **Coverage gaps read as silence.** Fires, incidents, sports, and other
   outlets' reporting simply didn't exist on the site, so the safety topic was
   a near-empty shelf.
5. **Bureaucratic voice in chrome.** Post types were named for the artifact
   (recap, preview, tracker) rather than the reader's question (what happened,
   what's coming).

What v1 got right and must survive: the violet provenance rule, honest counts
and zeroes, the dense record list, layered disclosure (clean prose → inline
stamps → inspection record), zero-JS delivery.

## Task and structure (v2)

Index order, top to bottom:

1. **Today** — the current daily brief, led by its date as a mark. Weather line
   (forecast + any active alerts), overnight/yesterday incidents, today's
   meetings and events, fresh record items (license events, filings, published
   recaps/previews), headlines elsewhere. **Sections are conditional — empty
   ones drop out.** A quiet day is weather + schedule and says so plainly.
2. **This week** — upcoming meetings/events strip; recent daily briefs.
3. **The record** — the four topic marks and the full dated list, exactly the
   v1 treatment, demoted in position but not in fidelity. Topic pages remain
   filtered views.
4. **Headlines elsewhere** items are attribution, not provenance: outlet-named
   crate-outline treatment, never violet (DESIGN.md ruling 2026-08-17).

Provenance layering is unchanged: clean prose, inline stamps on sourced claims,
inspection record in a native `<details>`.

## Proof and content

Real content only, computed from `content/published/`. The daily brief is a
post type the pipeline assembles (mostly Tier A); the site renders it, it does
not compose it. Until the assembler exists, the index must not fake a brief —
build the composition only when the content type is real.

**No invented proof.** Live since 2026-08-17 with no known readership: no
metrics, subscriber counts, testimonials, or "trusted by". No subscribe bar
until the Phase 3 newsletter exists.

## Constraints

- Zero client JS by default; one runtime maximum if ever earned.
- Content-collection schema mirrors `renderPostFile()`; `sources` stays
  `.nonempty()`; a new `daily-brief` post type extends the schema, never
  bypasses it.
- Only `content/published/` is built. Recaps are never called "minutes".
- Sports content is team-level only (EDITORIAL.md interim rule 2026-08-17).
- Secondary-press items render as 1–2 sentence attributed summaries + link,
  never substantial excerpts (EDITORIAL.md 2026-08-17).

## Chosen direction and memorable moment

**Dairy Inspection Mark** (seed 29a604d7), retained deliberately at the
2026-08-17 redirection — the stamp system is the moat made visible and gains
force on a daily surface: this morning's fire item carries the same violet
provenance as a council vote. The memorable moment is unchanged: **violet
inspection ink appears nowhere except on a sourced claim.**

## Unresolved

- **Topics are derived site-side** (`lib/record.ts` `topicsFor`); belongs in
  the pipeline. Unchanged from v1, and Phase 4's new sources make it more
  urgent (incident/sports/events items need topic homes: does `safety` absorb
  fire/EMS? does a fifth mark appear?). Topic taxonomy for the new content is
  an open design decision.
- **No accessibility standard has been set** (recorded in PRODUCT.md). The
  build holds the v1 floor: visible focus, landmarks, skip link, native
  disclosure.
- **Daily brief permalink shape** (one post per day at `/brief/YYYY-MM-DD`?)
  and how the index embeds vs links today's brief — decide when the assembler
  is designed.
