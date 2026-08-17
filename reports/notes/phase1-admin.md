# Phase 1 — Admin dashboard

Implements PLAN.md Phase 1 "Mechanics" → Admin dashboard (single Hono page,
localhost-bound) and the EDITORIAL.md Tier C enforcement rule. Owns
`src/admin/*.ts` and this file only; does not touch `src/pipeline/posts.ts`,
`src/db/schema.sql`, or any other agent's files.

## How to run it

```bash
node src/admin/server.ts
```

- Binds **127.0.0.1 only** (never 0.0.0.0) — never expose directly; it is
  meant to sit behind Caddy basic auth in a later phase.
- Port: `CVT_ADMIN_PORT` env var, default `8787`.
- DB: uses the standard `openDb()` default (`data/cvtoday.db`, or `CVT_DB`
  if set), same as every other pipeline entry point.
- No new dependencies. `hono` (already in package.json) provides the
  `Hono` app/router and its Fetch-API request/response contract
  (`app.fetch(request) -> Promise<Response>`). Since `@hono/node-server` is
  **not installed** and no new packages were added, `src/admin/node-adapter.ts`
  is a ~50-line hand-written bridge from `node:http`'s
  `IncomingMessage`/`ServerResponse` to the standard `Request`/`Response`
  objects Hono expects, using Node 24's built-in `Readable.toWeb` /
  `Readable.fromWeb` stream converters. No framework beyond Hono itself; the
  page itself ships zero client JS beyond native HTML forms (all actions are
  plain `<form method="post">` submits, no fetch/JSON API, per spec).

## File map

| File | Purpose |
|---|---|
| `src/admin/server.ts` | Entry point. Opens the DB, builds the Hono app, starts the `node:http` server, handles SIGINT/SIGTERM shutdown. |
| `src/admin/app.ts` | The Hono app: all routes, all four section renderers. |
| `src/admin/render.ts` | HTML escaping, the frontmatter parser (mirrors `pipeline/posts.ts`'s `renderPostFile` format), the hand-rolled markdown→HTML renderer, the generic gates/judge JSON→readable-reasons renderer, page layout + CSS. |
| `src/admin/audit.ts` | ISO-week computation, the deterministic sampling hash, rolling 30-day fail-count query. |
| `src/admin/node-adapter.ts` | `node:http` ↔ Fetch API bridge (see above) — the only "framework glue" code in this feature. |

## Route table

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | The dashboard: all four sections on one page. |
| GET | `/posts/:slug/view` | Reads the post's current `.md` file (whatever status it's in) and renders it as minimal HTML — frontmatter title/tier/type/status header + hand-rolled markdown body. Used by the Published feed's title links and Audit queue's title links. |
| POST | `/posts/:slug/approve` | Held-queue action. Requires `status = 'held'` (400 otherwise). For Tier C, requires form field `ack=1` (400 otherwise — see "Tier C enforcement" below). On success: `transitionPost(db, slug, 'published', ...)`, then `303` redirect to `/`. |
| POST | `/posts/:slug/reject` | Held-queue action. Requires `status = 'held'` (400 otherwise). `transitionPost(db, slug, 'rejected')`, `303` redirect to `/`. |
| POST | `/audit/:slug` | Audit-queue action. Form fields `verdict` (`pass`/`fail`, required) and `notes` (optional). Validates the post is Tier B, published, `held_reason IS NULL` (i.e. was auto-published, not manually reviewed — see "Audit sampling universe" below), is actually in this ISO week's sample, and hasn't already been audited this week — 400 on any of those failing. On success: `INSERT INTO audit_log`, `303` redirect to `/`. |

All POST actions are plain HTML form posts (`application/x-www-form-urlencoded`
via Hono's `c.req.parseBody()`), no JSON/fetch API, redirect back to `/` with
`303 See Other` on success.

## The four dashboard sections

**a. Published feed** — every `status = 'published'` post, reverse-chronological
by `published_at` (falling back to `created_at`). Each row: publish timestamp,
title (linked to `/posts/:slug/view`), tier badge, `post_type`, judge
faithfulness score, content flags, `source_count`. The judge column is
duck-typed out of `posts.judge` JSON by `summarizeJudge()` in `render.ts`: it
looks for a `faithfulness`/`faithfulness_score`/`score` key and a
`flags`/`content_flags` key (object-of-booleans or array-of-strings), and
degrades to "n/a" / "none" on anything it doesn't recognize — including `null`,
which `render.ts` and this report both treat as normal for Tier A (no LLM in
that path, so no judge verdict exists). *Verified empty-state and populated-state
both render correctly (see Verification below); the schema for `gates`/`judge`
JSON is not finalized elsewhere in the repo yet, so this renderer is
deliberately schema-tolerant rather than hard-coded to one shape.*

**b. Held queue** — every `status = 'held'` post as a card: title, tier/type
badges, `held_reason`, Gate 1 (`gates`) and Gate 2 (`judge`) JSON rendered by
`renderJsonReasons()` — a generic pretty-printer that walks the JSON tree and,
for any object carrying a boolean `pass`/`ok`/`passed`/`valid` field, renders a
green PASS or red FAIL badge inline (see Verification: this correctly
highlighted a failing `proper_names` gate and a `private_individual`/`crime`
judge flag in the test fixture). Below that, the draft body (frontmatter
stripped, rendered as HTML). Then Approve / Reject forms — Tier C enforcement
is on the Approve form specifically, described next.

**c. Audit queue** — see "Audit sampling algorithm" below for the mechanics.
Renders: sample rate and current ISO week, a table of this week's sampled
posts (title linked to the view route, `post_type`, and either Pass/Fail
buttons + a notes field, or — if already audited this week — the recorded
verdict badge, timestamp, and notes), and a rolling-30-day fail-count table by
`post_type` with a warning badge (`2+ fails this month — demote to
held-by-default (PLAN Gate 3)`) once a type hits the threshold PLAN.md
specifies.

**d. Pipeline health** — per source: `MAX(documents.fetched_at)`, document
count fetched since the start of the current ISO week (Monday 00:00 UTC), and
last-run status/error sourced from `reports/poc-data.json` (same file
`poc-report.ts` reads) if present, keyed by source `key`. Also shows the
`ranAt` timestamp of that recorded run. Verified against the repo's real
`data/cvtoday.db` + `reports/poc-data.json` — correctly lists all 11 scraper
sources with real `fetched_at` timestamps, this-week document counts, and OK
badges from the actual POC run.

## Audit sampling algorithm

Deterministic, seeded by ISO week, no persisted sample list — recomputed on
every page load from the `posts` table:

1. **ISO week string** (`isoWeekString()` in `audit.ts`): standard ISO-8601
   week-numbering (`YYYY-Www`), computed from the nearest Thursday, so it's
   correct across year boundaries.
2. **Sampling universe**: Tier B posts with `status = 'published'` AND
   `held_reason IS NULL`. See "Audit sampling universe" below for why
   `held_reason IS NULL` is the auto-vs-manual discriminator.
3. **Inclusion test** (`isSampledForAudit()`): `sha256(slug + ':' + isoWeek)`,
   take the first 4 bytes as a big-endian uint32, divide by 2³², compare
   against `AUDIT_RATE = 0.12` (midpoint of PLAN's 10–15% band). Stable for
   the entire week for a given slug (same hash all week), independent across
   posts, requires no stored state.
4. **Already-audited check**: `SELECT ... FROM audit_log WHERE post_id = ?
   AND iso_week = ?` — if present, the row renders as done (verdict badge +
   notes) instead of Pass/Fail buttons; the POST handler also 400s a
   duplicate submission for the same post+week.
5. **Rolling 30-day fail count** (`rollingFailCounts()`): `audit_log` joined
   to `posts`, `verdict = 'fail'` AND `audited_at >=` (now − 30 days),
   grouped by `post_type`. PLAN.md's "two substantive misses in a rolling
   month" threshold is rendered as a warning badge at `>= 2`; demoting the
   post type to held-by-default is a manual/pipeline-side action this
   dashboard surfaces but does not perform automatically (no post-type
   config table exists yet to write that decision into).

### Audit sampling universe — a documented design decision

The `posts` table has no "was this auto-published or human-approved"
column, and PLAN.md is explicit that the audit only covers *auto-published*
Tier B (`"deterministic sample of auto-published Tier B posts"` — EDITORIAL.md:
`"weekly human review of a 10–15% ISO-week-seeded sample of auto-published
Tier B"`). Since a Tier B post that fails a gate gets held and can later be
manually approved from this dashboard's Held queue, both paths end at
`status = 'published'` with no distinguishing column between them by default.

Rather than add a schema column (out of file-ownership scope — `src/db/schema.sql`
belongs to another agent), the Approve handler in `app.ts` uses the existing
`held_reason` field as the discriminator: **manual approvals from the held
queue always write a non-null marker** (`"reviewed:approved"`, or
`"reviewed:approved (Tier C acknowledgment confirmed)"` for Tier C) into
`held_reason` as part of the `transitionPost(..., 'published', { heldReason:
... })` call, even though the post is no longer held. A post that auto-publishes
through the (not-yet-built, out of this agent's scope) pipeline code never
touches this admin's approve handler, so its `held_reason` stays `NULL` as the
column already defaults to. The audit queue's `WHERE ... held_reason IS NULL`
filter therefore selects exactly the auto-publish path. The Reject handler
does **not** overwrite `held_reason` — it leaves the original hold reason in
place as the historical record of why the post was held before rejection.

This is a judgment call under the given constraints, flagged here explicitly:
if a future agent adds a proper `published_via` or `reviewed_by` column to
`posts`, the audit query in `app.ts`'s `renderAudit()` (and the POST
`/audit/:slug` eligibility check) should switch to that column instead of the
`held_reason IS NULL` heuristic.

## Tier C enforcement mechanics

EDITORIAL.md: *"Tier C — human always, judge cannot override... Publish
requires an explicit per-item acknowledgment. No exceptions."*

- The Approve form in the Held queue includes, **only when `post.tier ===
  'C'`**, a checkbox: `<input type="checkbox" name="ack" value="1" required>`
  with the exact label text `"I have reviewed this item naming private
  individuals"`.
- The `required` HTML attribute is a UX nicety, not the enforcement — a raw
  `curl -X POST` bypasses it entirely. The actual enforcement is server-side
  in `app.ts`'s `POST /posts/:slug/approve` handler:

  ```ts
  if (post.tier === 'C' && str(form.ack) !== '1') {
    return c.text('Tier C approve rejected: required acknowledgment checkbox
      ("I have reviewed this item naming private individuals") was not
      checked.', 400);
  }
  ```

- Verified directly (see below): POSTing approve for a Tier C held post with
  no `ack` field returns `HTTP 400` and the post's `status`/`file_path` are
  unchanged (still `held`, file still under `content/held/`). POSTing again
  with `ack=1` returns `303`, the DB row flips to `published`, and the `.md`
  file is physically renamed from `content/held/<slug>.md` to
  `content/published/<slug>.md` by `transitionPost()`.
- Tier A/B held posts (gate failures, not private-individual content) have no
  ack requirement — the checkbox block is simply omitted for them.

## Out of scope (deliberate)

- **CSRF protection**: none. The dashboard binds to `127.0.0.1` only and is
  designed to sit behind Caddy basic auth on the same host in a later phase
  (per PLAN.md Phase 1 Mechanics); there is no cross-origin exposure to
  protect against yet. Revisit if this ever gets reverse-proxied to a
  non-localhost-only listener before auth is added.
- **Authentication**: none in this code. Caddy basic auth is the documented
  plan (PLAN.md: *"Admin dashboard at `/admin`, Caddy basic auth"*); this
  service has no login of its own.
- **Automatic post-type demotion to held-by-default** on 2+ rolling-month
  audit fails: the dashboard *surfaces* the warning (visible badge) but does
  not write a config change anywhere — there's no post-type config table in
  this schema yet for it to write to.
- **Edit-in-place for held drafts**: PLAN.md's Held-queue bullet mentions
  "approve/edit/reject actions" in one place; this implementation only does
  Approve/Reject (matching the *dashboard section spec* passed to this agent,
  which lists only those two actions). No edit UI was built.

## Verification — results

All run against the real repo DB (`data/cvtoday.db`, populated by the Phase 0
scraper run) with the server on `127.0.0.1:8787`.

1. **`npx tsc --noEmit`** — PASS, clean, no errors.
2. **Server starts and binds 127.0.0.1** — PASS. `node src/admin/server.ts`
   logs `admin dashboard listening on http://127.0.0.1:8787`; confirmed via
   `lsof -nP -iTCP:8787 -sTCP:LISTEN` showing the bound address as `127.0.0.1`.
3. **`GET /` returns 200 with all four sections** — PASS. `HTTP 200`;
   response contains `<h2 id="published">`, `<h2 id="held">`,
   `<h2 id="audit">`, `<h2 id="health">`. Pipeline health section correctly
   lists all 11 real scraper sources with real `fetched_at` timestamps,
   this-week document counts, and OK status badges pulled from
   `reports/poc-data.json`.
4. **Throwaway Tier C post** — created via `createPost()` +
   `transitionPost(db, slug, 'held', { heldReason, gates, judge })` with a
   `gates` payload containing one failing check and a `judge` payload with
   `private_individual`/`crime` flags set. Confirmed the Held queue section
   rendered the FAIL badge on the failing gate and both judge flags legibly.
5. **Approve WITHOUT ack → 400, post stays held** — PASS.
   `POST /posts/zz-throwaway.../approve` (no `ack` field) returned
   `HTTP 400` with the expected message; `content/held/` still contained the
   file and the DB row still showed `status=held`.
6. **Approve WITH ack → succeeds, file physically moves** — PASS.
   `POST /posts/zz-throwaway.../approve` with `ack=1` returned `HTTP 303`
   (redirect to `/`); DB row flipped to `status=published`,
   `file_path=content/published/...`, `held_reason='reviewed:approved (Tier
   C acknowledgment confirmed)'`, `published_at` set. Confirmed by directory
   listing: file gone from `content/held/`, present in `content/published/`.
   Confirmed the Published feed row rendered the correct tier badge, judge
   score (`0.5`), both flags as FAIL badges, and `source_count=1`.
7. **`GET /posts/:slug/view`** — PASS, `HTTP 200`, renders the frontmatter
   title/tier/status header and the markdown body (including the disclosure
   footer) as HTML.
8. **Edge cases** — PASS: `POST /posts/:slug/reject` on the now-published
   post returned `HTTP 400` ("not in the held queue"); `GET
   /posts/does-not-exist/view` returned `HTTP 404`.
9. **Cleanup** — the throwaway post row was deleted from `posts`
   (`DELETE FROM posts WHERE slug = ...`) and its `.md` file removed from
   `content/published/`. Confirmed `SELECT COUNT(*) FROM posts` returns `0`
   and `content/` has no tracked or untracked files left. Server killed
   (`pkill -f "src/admin/server.ts"`), port confirmed free.

`git status` after cleanup shows only `src/admin/` (this feature) and this
report as new files under this agent's ownership; no other agent's files were
touched, and no test artifacts remain in `content/` or the DB.
