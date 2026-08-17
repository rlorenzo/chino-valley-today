# EDITORIAL.md — editorial rules for Chino Valley Today

These rules bind every publishing path, human or automated. The pipeline
enforces what it can (tiers, gates, validators); the rest binds the human
reviewer. Changes to this file are editorial decisions — date them.

## Provenance

- Every published claim links to a primary source: agenda item permalink, PDF
  page, video timestamp, news-release permalink, alert URL. No source, no claim.
- Source links are provided everywhere but are not a safety mechanism: a wrong
  claim harms someone whether or not it cites its source. That is what the
  gates are for.
- Generated recaps are summaries of the public record, NEVER "minutes."
  Official minutes are a legal record adopted by the body. Label accordingly.

## Tiers (binding routing rules)

- **Tier A — auto-publish, zero LLM:** deterministic template rendering of
  structured data (alerts, meeting previews quoting agenda titles verbatim,
  license-event listings, headline+link digests, calendar items). Maximize
  what fits here; a template that quotes verbatim with links cannot hallucinate.
- **Tier B — auto-publish only on clean machine pass:** LLM-generated recaps
  and tracker narratives. Must pass Gate 1 (deterministic validators: citation
  coverage, numeric consistency, proper-name whitelist) AND Gate 2 (LLM judge
  from a different model family, structured verdict). Any flag → held.
- **Tier C — human always, judge cannot override:** crime items naming private
  individuals, anything involving minors, personnel or legal allegations,
  corrections, and anything the judge flags private_individual. Publish
  requires an explicit per-item acknowledgment. No exceptions.
- **Audit:** weekly human review of a 10–15% ISO-week-seeded sample of
  auto-published Tier B. Two substantive misses in a rolling month → the post
  type is demoted to held-by-default until gates are tightened.

## Private persons

- Never auto-publish the name of a private individual. Elected officials,
  senior public employees acting in their official capacity, and business
  principals in the context of their license/application are public-role
  exceptions — but crime/allegation contexts are Tier C regardless of role.
- Minors: never named, never described identifiably, Tier C always — even if
  a source document names them (sheriff/coroner releases do).
- Coroner and sheriff release bodies are stored verbatim in the database
  (faithful archive); publication is where these rules bite.

## Contested school-district items

- No characterization of contested CVUSD items: votes, direct quotes (with
  timestamps), and links only. The recap may state what was decided and who
  voted how; it may not describe motives, tone, or sides beyond quoted words.

## Secondary press

- The Champion (championnewspapers.com) and all secondary press: link-only,
  at most one line of neutral framing. Never scrape, never excerpt beyond a
  headline. We cover the record, not the coverage.

## Source channels (decision 2026-08-12)

- Agency-operated notification channels (e.g. the Sheriff's Nixle channel)
  are primary sources. Ingestion must respect the platform's terms: Nixle is
  ingested via email subscription (its intended delivery), never page
  scraping. Cited URL = the nixle.us permalink in the message.
- User-generated platforms (Facebook, Nextdoor) remain excluded as sources.

## Corrections

- Corrections are visible: strikethrough + dated correction note on the post.
  Never silent edits. Substantive corrections get a note in the next digest.
- The corrections address is `corrections@chinovalley.today` (decided
  2026-08-17, routed to the operator by Cloudflare Email Routing).
- Every post footer: "Generated from public records with automated review;
  see sources linked above. Corrections: see About page." The footer points at
  the About page rather than carrying the address inline, deliberately: the
  address can then change without editing a single published post, which this
  document forbids doing silently. The About page is where the address is
  published.
- A correction to a Tier B post counts as an audit miss for gate-tightening.
