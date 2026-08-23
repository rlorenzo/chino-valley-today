# PLAN.md - Chino Valley Today

A daily local news brief for Chino and Chino Hills, CA, live at
<https://chinovalley.today>: automated ingestion of primary sources and
official feeds, LLM synthesis with mandatory source citations, tiered machine +
human review gates, static site output. Modeled on tucsondailybrief.com.

This file tracks **open work**. Binding editorial rules live in EDITORIAL.md,
per-source behavior in SOURCES.md, operations in deploy/README.md, product
positioning in PRODUCT.md, visual system in DESIGN.md. Completed phases are
summarized below; their detail is in git history and the PRs they link.

---

## Status (2026-08-22)

- **Phases 0-2 COMPLETE.** 25+ sources ingesting, tiered gate live, site
  deployed to a shared droplet behind Cloudflare, systemd timers + nightly B2
  backup running, deploy-on-push CI verified. Infrastructure identifiers live
  in the private Obsidian note, deliberately not in this public repo.
- **Phase 4 in progress** (daily brief + expanded sources). Merged: 4.0, 4.1,
  4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10. Open: **4.8** (spec below).
- **Phase 3 not started** (podcast + newsletter + growth), deliberately
  re-sequenced after Phase 4 — the newsletter is strictly better fed by a
  daily brief.
- **7-day daily-brief acceptance streak restarted 2026-08-20** after the
  prerequisite-tiering fix (PR #33) deployed. The 08-22 brief was regenerated
  by hand twice that evening to deploy the two fixes below; no human writing
  was involved, but the 06:00 timer run was not what readers saw that day.
- **A tag archive led the front page ([PR #35](https://github.com/rlorenzo/chino-valley-today/pull/35)).**
  dailybulletin.com publishes stub permalinks matching the article path shape
  whose only job is to 301 onto a tag archive. `ingestArticles` stored
  `doc.finalUrl` without re-checking it was still an article, so the archive's
  `<head>` became an item: a tag name for a headline, no teaser, and
  `occurred_at` read off the newest `<time>` in the listing — so it re-dated
  itself every scrape, never aged out, and outranked every real story. It was
  the entire **In the local press** section on 08-22. Path shape is now
  asserted at three points, and one of them had to move: the renderer's check
  ran *after* selection had capped at five, so an invalid row still took a
  slot from an article that could have filled it.
- **A superseded heat advisory sat beside its replacement ([PR #36](https://github.com/rlorenzo/chino-valley-today/pull/36)).**
  `alertAdvisoryKey` groups on `(event, ends, areaDesc)`, so an Update that
  *extends* an advisory reads as a second advisory. Right for post identity —
  it keeps a slug stable across re-issues — and wrong for a reader, who was
  told the heat ended a day early. The brief now groups on `(event, areaDesc)`
  and keeps the newest issuance; the post generator is unchanged. Distinct
  products still stand apart: an Extreme Heat Watch overlapping an advisory is
  a second warning, not a duplicate.
- **Every active alert was stored twice** (same PR). The scraper reads two
  feeds and item identity is `(document url, item_type, external_id)`, so an
  alert listed by both was inserted once per feed. 11 pairs cleared from
  production with `scripts/dedupe-alert-items.mjs`; the scraper now collects
  across both feeds before storing.
- **Two of the night's defects were invisible to the gate**: a source edit
  that silently failed to apply, and a test that passed for the wrong reason
  because its two timestamps happened to sort the same way as strings and as
  instants. Both were caught by re-reading code already reported as done, not
  by a test. Task 4.10 shipped for that reason
  ([PR #38](https://github.com/rlorenzo/chino-valley-today/pull/38)): both
  shell suites now run in `npm run check` and in CI. CI needed a step of its
  own — the workflow calls `npm run coverage` directly and never calls
  `check`, so chaining into `check` alone would have left them unrun in the
  one place that gates a merge.

### Open decisions

- CVUSD agenda-PDF robots exception: scoped `skipRobots` vs listing-only.
- Student-athlete naming vs the minors rule (interim rule is team-level only;
  see EDITORIAL.md).
- Published posts live only on the droplet — nothing pushes them back to git.
  Decide: write-capable deploy key with auto-commit on publish, or make
  committing part of the review ritual.

---

## Guiding constraints

1. **Provenance is non-negotiable.** Every published claim links to a primary
   source (agenda item URL, PDF page, video timestamp, release permalink). The
   DB schema enforces it: an `item` without `source_url` is a constraint
   violation. Validators reject generated output containing uncited claims.
2. **Static output.** The public site is plain HTML/CSS generated at publish
   time. No server-side runtime for visitors.
3. **Local-first data.** SQLite (`node:sqlite`, WAL) at `data/cvtoday.db`. Raw
   fetched artifacts stored under `data/raw/`, content-addressed by SHA-256.
   Nothing external except source fetches and LLM inference calls.
   **The raw archive is the moat; do not lose it.**
4. **Risk-tiered publishing gate.** Not everything needs human eyes; the
   riskiest things always get them. Tier A auto-publishes (deterministic
   templates, no generation = no hallucination); Tier B auto-publishes only
   past deterministic validators plus a cross-family LLM judge; Tier C always
   gets a human. Full binding spec in EDITORIAL.md. Source links are provided
   everywhere but are not a safety mechanism: a wrong claim harms someone
   whether or not it cites its source.
5. **Polite scraping.** Respect robots.txt read mechanically against our own
   honest User-Agent (contact email included), plus any binding platform ToS.
   Conditional GET where supported; never re-fetch unchanged documents.
   Secondary press is fetchable under exactly these rules, with published
   output limited to short attributed summaries (EDITORIAL.md).
6. **A source being down for a day is normal.** It must not cost us the other
   twelve. Only `nws-forecast` and `nws-alerts` block the daily brief, because
   a brief showing no alert *because the alert feed failed* asserts something
   false. Every other source degrades its own section by name.

---

## Stack

- **Runtime:** Node 24 LTS, TypeScript, ESM. DB via `node:sqlite` (stable
  built-in, synchronous, zero deps).
- **Scrape/parse:** undici, cheerio, pdf-parse, fast-xml-parser, yt-dlp via
  child_process (YouTube captions; a host dependency, not npm).
- **LLM inference:** DigitalOcean Gradient serverless (OpenAI-compatible).
  Single `src/llm/client.ts` with per-task `{model, endpoint}` config, so any
  task can be repointed (including to Anthropic) without code changes.
  Generator `deepseek-4-flash`; judge `qwen3.5-397b-a17b` (backup `glm-5.2`);
  escalation `kimi-k3`. Judge must be a different model **family** than the
  generator — same vendor is fine, the point is uncorrelated failure modes.
  Gradient rejects `max_tokens` combined with `response_format: json_object`;
  the client omits it in JSON mode.
- **Static site:** Astro, zero client JS by default. Vanilla `<script>`
  modules for simple behavior; Solid (`client:visible`) only if a widget ever
  earns a framework. Search later via Pagefind.
- **Scheduling:** systemd timers on the droplet. **Deploy:** rsync to a
  Caddy-served directory; the build runs on the host, not the CI runner,
  because `content/published/` is written on the host at approval time.

## Data model

Authoritative schema: `src/db/schema.sql` (sources, documents, items, posts,
audit_log, scrape_runs, source_tos_status). Two distinctions worth stating
outside the file:

- `documents.url` answers "where did this file come from"; `items.source_url`
  answers "where should the reader click." They often differ.
- `items.source_url` is the *deepest stable* link available: Legistar item
  permalink, YouTube URL with `t=` offset, PDF URL with `#page=N`.

---

## Completed phases

- **Phase 0 — Scraper POC** (commit `effdfed`). 12 sources ingesting, all
  acceptance criteria verified, all 7 open questions answered. Answers and
  per-source quirks are in SOURCES.md; the probe dossiers are in
  `reports/notes/`. `npm run poc` regenerates `reports/poc.html`.
- **Phase 1 — Synthesis + tiered gate** (commits `2598a8d`..`6bf3f1d`).
  Post lifecycle, Tier A generators, Gate 1 validators, Gate 2 cross-family
  judge with Tier C routing, recap pipeline, admin dashboard, LLM client,
  business-tracker narrative. First full Tier B lifecycle completed
  2026-08-13; every hold was the designed protection working.
- **Phase 2 — Static site + droplet** (2026-08-17). Astro build, Cloudflare +
  Origin CA TLS, systemd scrape/backup timers, nightly offsite backup to B2,
  deploy-on-push CI.
- **Phase 4 merged so far:** 4.0 source probes; 4.1 easy verified set (seven
  scrapers); 4.2 headlines-elsewhere ingestion ([PR #28]); 4.3 daily brief
  assembler ([PR #27]) plus prerequisite tiering ([PR #33]) and the root-run
  deploy guard ([PR #34]); 4.4 index leads with Today (`941f2f7`, attribution
  treatment in [PR #28]); 4.6 City Alert Center feeds ([PR #30]); 4.7 student
  press + NBC4 ([PR #31]); 4.5 pipeline-owned topic taxonomy ([PR #42], host
  backfill run 2026-08-23); 4.9 repeated press headlines demoted, not dropped
  ([PR #39]).

[PR #27]: https://github.com/rlorenzo/chino-valley-today/pull/27
[PR #28]: https://github.com/rlorenzo/chino-valley-today/pull/28
[PR #30]: https://github.com/rlorenzo/chino-valley-today/pull/30
[PR #31]: https://github.com/rlorenzo/chino-valley-today/pull/31
[PR #33]: https://github.com/rlorenzo/chino-valley-today/pull/33
[PR #34]: https://github.com/rlorenzo/chino-valley-today/pull/34
[PR #39]: https://github.com/rlorenzo/chino-valley-today/pull/39
[PR #42]: https://github.com/rlorenzo/chino-valley-today/pull/42

---

## Phase 4: open tasks

### Task 4.8 - HS sports scores (endpoints verified 2026-08-19; build pending)

Team-level scores/schedules/standings for the four CVUSD high schools.

- **Home Campus platform** covers three schools: `POST /wp-json/sports/v1/main-teams`
  returns full schedule/score JSON, no session or nonce. School IDs: Chino 103,
  Ayala 28, Don Lugo 143. One scraper core serves all three.
- **Chino Hills (104)** has no Home Campus site: use the CIF-SS schedule-score
  widget (server-rendered, citable GET per sport) or chhuskies.com's PlayOn RSC
  payload.
- **League membership is per-sport.** Chino Hills is Baseline; Ayala is
  Palomares except football (Baseline); Chino High and Don Lugo are Mt. Baldy.
  Both conflicting recon hits were right — always qualify a league claim by sport.
- **Citation caveat:** the API carries `x-robots-tag: noindex`. Cite the human
  page, never the API URL. Officers' PII in the league-directory JSON stays out.
- Rejected platforms: scores.cifss.org (AWS WAF), athletic.net (robots blocks
  exactly the team-result pages), sblivesports.com (blanket 403).

### Phase 4 acceptance

- [ ] Seven consecutive mornings publish a daily brief with zero human writing
      (human review only where tiers require it)
- [ ] A quiet day ships honestly (weather + schedule, no padding)
- [ ] Every brief item's link passes the citation spot-check ritual
- [ ] Headlines-elsewhere items render as short attributed summaries only
- [ ] No student-athlete name anywhere (team-level rule holds)
- [x] Index leads with Today; the record remains fully reachable and citable

---

## Phase 3 (outline): Podcast + newsletter + growth

- TTS from published recap posts; RSS podcast feed (static XML + mp3s).
- Email: Buttondown or Listmonk-on-droplet fed by the same content. Note that
  Cloudflare Email Routing forwards only — it cannot send, so the newsletter
  needs a sending provider regardless.
- Validation gate: soft-launch a manual recap in the Chino Facebook group;
  under 200 subscribers after 3 months of consistent posting = archive the
  project.

## Costs

- Droplet: $0 marginal (colocated on an existing host).
- Domain: ~$22/yr at cost on Cloudflare.
- LLM inference: cents per post for generation + judging combined; budget as
  if prompt caching never engages (~2-3¢/recap). DO prompt caching was closed
  as not-caller-fixable in 2026-08 — the feature is opportunistic Public
  Preview and never engaged for us despite verified-deterministic prompts.
- TTS (Phase 3): DO Gradient, ~$0.60 per recap narration at ElevenLabs rates.
