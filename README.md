# Chino Valley Today

A daily local news brief for Chino and Chino Hills, California, live at
<https://chinovalley.today>. Every morning it assembles what a resident needs to
know today: forecast, active weather alerts, overnight incidents, today's
meetings and events, fresh items from the public record, and attributed
headlines from other outlets. Underneath the brief sits a slower pipeline that
publishes meeting previews, meeting recaps, alerts and business-license
narratives from primary sources.

It runs on one shared 1GB droplet for roughly the cost of the domain. There is
no newsroom and no full-time operator. The interesting part is not the code, it
is the set of constraints that let a mostly automated local news site publish
without lying to anyone.

**This repo is meant to be copied.** If you want to do this for your own town,
the sections below are ordered to get you from "what is this" to "what do I
change".

---

## The three ideas worth stealing

Everything else is implementation detail around these.

**1. Provenance is enforced by the schema, not by discipline.** Every published
claim links to a primary source: an agenda item permalink, a PDF page anchor, a
video URL with a `t=` offset, a release permalink. `items.source_url` has a
`CHECK (length(source_url) > 0)` constraint, so an item without provenance is a
database error rather than a bad habit. Generated text that contains an uncited
sentence fails a validator before it can publish.

**2. Publishing is risk-tiered, so automation and safety are not in tension.**

| Tier | What it is | How it publishes |
| --- | --- | --- |
| A | Deterministic templates over already-stored items. No LLM, so no hallucination. | Auto |
| B | LLM synthesis (meeting recaps, business narratives). | Auto only after Gate 1 validators *and* a cross-family LLM judge both pass |
| C | Anything naming a private individual, a minor, an allegation, a personnel or legal matter. | Always a human, with a server-enforced acknowledgment checkbox |

The daily brief is mostly Tier A, which is why daily cadence is affordable: it
is assembled from items that already passed the gate, so publishing daily never
requires writing daily.

**Gate 1 (deterministic):** every paragraph is cited from the input URL set;
every number in the output appears in the inputs; every proper name in the
output appears in the inputs. That last one exists because automatic speech
recognition garbles names, and a garbled name is a real person being
misidentified.

**Gate 2 (LLM judge):** a different model *family* than the generator, because
the point is uncorrelated failure modes. Structured per-claim verdict, plus
content flags that route to Tier C. Fail-closed: anything unparseable is a
failure.

Rule learned the hard way: **fix the template, never loosen the gate.** When
Gate 1 correctly rejected a Tier A template for citing per-block instead of
per-fact, the template changed.

**3. Politeness is mechanical, not aspirational.** robots.txt is parsed and
obeyed by machine against an honest User-Agent carrying a contact address.
Conditional GET everywhere it is supported. Terms of Service for each press
source are hashed into `source_tos_status` and re-checked weekly by a watchdog,
against the last version a human actually read in full, not against last week,
so a redesign that migrates a clause across several deploys cannot slip through
one diff at a time. Drift fails closed. One source in this repo is deliberately
*unregistered* rather than merely disabled, because a scraper that is not in the
registry cannot be invoked even by hand.

---

## Architecture

```text
scrapers (35+)  ->  SQLite: sources / documents / items
                    raw bytes archived by sha256 under data/raw/
                          |
      +-------------------+--------------------------+
      |                                              |
  Tier A templates                          Tier B synthesis
  (zero LLM)                                bundle -> generator model
      |                                              |
      |                                     Gate 1 validators
      |                                              |
      |                                     Gate 2 cross-family judge
      |                                              |
      |                          clean pass  |  any failure or Tier C flag
      v                                      v                 v
 content/published/  <------------------  published        content/held/
      |                                                          |
      |                                            admin dashboard (localhost)
      |                                            held queue, Tier C ack, audit
      v
 Astro static build  ->  rsync to droplet  ->  Caddy  ->  readers
```

Two things that are easy to miss:

- **The site does not own the corpus, it renders it.** Posts are markdown with
  frontmatter in `content/published/`. Astro reads that directory through a
  content collection whose Zod schema mirrors exactly what the pipeline writes,
  so frontmatter drift fails the build instead of shipping a broken page.
- **The build runs on the host, not the CI runner**, because posts approved in
  the dashboard are written on the host. A runner-built site would silently omit
  them.

---

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/scrapers/` | One file per source, plus the registry that names them. The bulk of the town-specific code. |
| `src/db/` | `schema.sql` is authoritative. Insert helpers, idempotency, ToS status. |
| `src/tiera/` | Deterministic generators: meeting previews, alerts, news digest, business tracker. |
| `src/pipeline/` | Bundling, the daily brief assembler, gate runs, judge, post lifecycle, topic taxonomy. |
| `src/gates/` | Gate 1 validators, policy filters (private persons, minors), allowlists, ToS config. |
| `src/llm/` | One client, per-task `{model, endpoint}` config. Repointing a task at another provider is config, not code. |
| `src/podcast/` | Weekly episode: script assembly, TTS, audio, feed health. |
| `src/admin/` | Hono dashboard, localhost only. Held queue, Tier C acknowledgment, weekly audit. |
| `site/` | Astro static site. Zero client JS by default. |
| `content/` | `queue/`, `held/`, `published/`, `rejected/`. Status is the directory. |
| `data/` | SQLite DB and the raw archive. Gitignored. Back it up. |
| `scripts/` | Scrape group runner, deploy, drift and ToS watchdogs, backups, one-off migrations. |
| `deploy/` | systemd units, Caddy site block, provisioning notes. |
| `tests/integration/` | Shell tests for the deploy and brief scripts. |

Docs, in the order worth reading them: [`PRODUCT.md`](PRODUCT.md) (who it is
for and why), [`EDITORIAL.md`](EDITORIAL.md) (the binding publishing rules),
[`PLAN.md`](PLAN.md) (phases, constraints, current status),
[`SOURCES.md`](SOURCES.md) (every source, its endpoint, and its quirks),
[`DESIGN.md`](DESIGN.md) (the visual system), [`deploy/README.md`](deploy/README.md)
(provisioning).

---

## The scraper contract

A scraper is a module exporting a `ScraperDef`. The runtime hands it a context
and gets back nothing; side effects go through the context so that archiving,
robots checks, conditional GET, deduplication and run accounting are not each
scraper's problem.

```ts
export default {
  key: "example-agendas",
  name: "Example City agendas",
  baseUrl: "https://example.gov",
  method: "html",
  async run(ctx) {
    const doc = await ctx.fetchDocument(url, { docType: "agenda", meetingDate });
    ctx.insertItem({
      document_id: doc.documentId,
      source_url: itemPermalink,  // the deepest stable link a reader should click
      item_type: "agenda_item",
      external_id: nativeId,      // stable, source-native, or items duplicate every run
      title, body, meta, occurred_at,
    });
    ctx.note("anything surprising about this source");
  },
} satisfies ScraperDef;
```

Four rules that came out of real breakage:

- **`external_id` must be source-native.** Content hashes do not work: CivicPlus
  feeds embed a volatile `lastBuildDate`, ASP.NET pages embed per-request
  `__VIEWSTATE`, Swagit embeds CSRF tokens, so those documents re-hash on every
  fetch. Item identity is `(document url, item_type, external_id)`.
- **`documents.url` and `items.source_url` are different questions.** The first
  is where the file came from. The second is where a reader should click.
- **Failures are per-scraper.** Each runs in its own process and one going down
  must not cost you the other twelve. Only the forecast and alert feeds can
  block the daily brief, and only because a brief that shows no alert *because
  the alert feed failed* asserts something false. Everything else degrades its
  own section by name, so an empty events list reads as "we could not reach the
  library calendar" rather than "nothing is happening".
- **Register it, then schedule it.** A scraper in the registry but in no scrape
  group is merged and inert, and every one of its tests still passes. There is a
  test (`src/scrapers/scrape-groups.test.ts`) that exists purely to connect the
  TypeScript registry, the shell group runner and the systemd units, because
  nothing else does.

Sources that cannot be fetched at all are still supported: `ctx.ingestLocal()`
takes bytes a human downloaded by hand (one county's minutes portal disallows
automated retrieval) down the same content-addressed path.

---

## Data model

Authoritative in [`src/db/schema.sql`](src/db/schema.sql). The shape:

- `sources` one row per scraper key.
- `documents` one row per distinct fetched artifact, content-addressed by
  sha256, with the raw bytes kept under `data/raw/`. `UNIQUE(url, content_hash)`.
- `items` the atoms: agenda items, votes, news releases, alerts, license events,
  transcript segments, events. Provenance enforced here.
- `posts` lifecycle state and audit only. Post *content* is the markdown file;
  the DB never becomes a second source of truth for text.
- `scrape_runs`, `audit_log`, `source_tos_status`, `tos_attestations`.

The raw archive is the moat. Feeds roll off, videos get pulled, agenda portals
get redesigned. Losing `data/` means losing everything you cannot re-fetch, and
it is gitignored, so it needs its own backup from day one rather than at the
point where a proper backup job is convenient.

---

## Running it locally

Node 24 or newer, no build step (native TypeScript type stripping, ESM).

```bash
npm install
cp .env.example .env        # LLM key only needed for Tier B
npm run poc                 # run every scraper, write reports/poc.html
npm run one <source-key>    # run a single scraper
npm run tiera               # deterministic generators
npm run brief               # assemble today's daily brief
npm run recap               # Tier B meeting recap through both gates
npm run admin               # dashboard on 127.0.0.1:8788
npm run check               # typecheck, lint (ts/md/sh), dead code, unit + integration tests
cd site && npm install && npm run dev
```

`.env` is documented in [`.env.example`](.env.example), including what each key
is for and what degrades if you leave it blank. The only hard requirement for
the deterministic half of the pipeline is nothing at all: Tier A, the brief and
the site run with an empty `.env`.

---

## Scheduling and deployment

Scrapers are grouped by useful polling rate, not by subject, and each group is a
systemd timer:

| Group | Cadence | Why |
| --- | --- | --- |
| `frequent` | hourly | News feeds, weather alerts and forecast, fire feeds, alert mailbox. Cheap and high-churn. |
| `daily` | 05:40 | Agenda systems, event calendars, licenses, school sports. These change when a clerk posts something. |
| `media` | 07:30 | Video and captions. Expensive, and captions do not exist until after a meeting ends. |
| `press` | separate | Secondary press, so its politeness budget is independent. |

Then 05:50 Tier A generation, 06:00 daily brief, 02:20 backup, plus watchdogs
for ToS drift, code drift and installed-unit drift. All units cap `MemoryMax`
and run at idle IO priority, because the droplet is shared with unrelated sites
and a runaway scrape should be OOM-killed rather than take them down.

Deployment is a push to `main`, which reaches the host over an SSH key pinned to
a single forced command with no pty and no forwarding. The site is rsynced into
a timestamped release directory and symlinked. See
[`deploy/README.md`](deploy/README.md) for provisioning, and note the deliberate
sharp edge: the deploy refuses to run when published content on the host differs
from git, because an edit to an already-published post is what a *visible
correction* looks like, and a routine `git reset --hard` would silently revert
it.

---

## Adapting this to your town

Roughly in order of effort.

**1. Probe before you build.** This is the single highest-value step and the one
most likely to be skipped. Nearly every platform assumption in the original plan
died on contact: one city's agendas were in AgendaQuick rather than the
CivicPlus Agenda Center everyone assumed, the other city's Agenda Center was
dormant with one PDF since 2022, the school district was on a CMS nobody
guessed, and the sheriff had moved distribution to an alerting service entirely.
Find the actual endpoints first. `reports/notes/` shows the shape of a probe
dossier per source.

Platforms you will probably meet, all of which have a working scraper here to
copy: Legistar (prefer its Web API over scraping), CivicPlus / CivicEngage RSS,
AgendaQuick, Swagit, BoardDocs-alikes, The Events Calendar (Tribe) REST,
`api.weather.gov`, state ABC license feeds, USGS FDSN, YouTube captions via
yt-dlp.

**2. Replace the source registry.** `src/scrapers/registry.ts` plus one file per
source, and `SOURCES.md` as you learn each one's quirks. Then put every new key
in a group in `scripts/run-group.sh`, or the test in
`src/scrapers/scrape-groups.test.ts` will fail, which is the point of it.

**3. Rewrite the allowlists.** `src/gates/allowlists.ts` holds your elected
officials, civic entities and local geography. This is what lets Tier A publish
a name automatically, and everything not on it routes to a human. It is
town-specific by definition and it is also the file where a mistake has the
highest cost.

**4. Read `EDITORIAL.md` and make it yours.** Do not copy the rules without
deciding them. The consequential ones: what counts as a private individual, how
minors are handled, whether student athletes can be named (interim answer here:
team-level only), how much of a secondary outlet's story you may summarize, what
a correction looks like, and why a recap is never called "minutes" (official
minutes are a legal record; yours are a labeled summary with a disclosure
footer).

**5. Decide your LLM posture.** The client is one file with per-task model
config, so the generator, judge and escalation models are swappable without code
changes. Keep the cross-family rule for generator versus judge. Or skip Tier B
entirely: the daily brief, the alerts, the meeting previews and the event
calendar are all Tier A, and a deterministic-only version of this site is a
genuinely reasonable product.

**6. Re-skin.** `DESIGN.md` describes a deliberately specific visual world with
one rule that has teeth: a single violet ink signifies primary civic provenance
and nothing else may wear it. Secondary press attribution uses a different
token. Whatever your design is, having one inviolable provenance signal is worth
keeping.

**7. Host it.** One small droplet, Caddy, systemd timers, a static site behind a
CDN. There is no application server for readers, so the load profile is a
directory of files.

### What will bite you

Condensed from `PLAN.md` and the project's own postmortems, because these are
cheaper to read than to rediscover:

- **robots.txt misleads in both directions.** Two agenda vendors ship a template
  whose `Disallow: /` lines are commented out, so it looks blocked and is not. A
  school district put its public agenda PDFs behind a blanket SEO `Disallow`, so
  they are blocked and should not be fetched. Parse it, never eyeball it.
- **A WAF blocking a public record is not the end.** One county library's site
  403s every scripted request, while the identical CMS serves openly from a
  sibling official hostname. Look for the same content on another government
  domain before writing a source off.
- **Vendor APIs lie in specific ways.** One agenda platform's API and its public
  website use different ID spaces for the same matter, so API-built permalinks
  return a valid-looking error page. Its votes endpoint returns a *different*
  item's votes, with HTTP 200, for consent-calendar members.
- **One timestamp column, two meanings.** Some sources give full UTC instants
  and some give bare dates. A naive date slice put a cancelled-meeting notice on
  the wrong day. Normalize per source at read time.
- **A guard that fires on everything gets ignored.** A minors filter matching any
  `<n>-year-old` would hold 40-year-old suspects. The next version matched
  `boys?|girls?` and held every release mentioning a real street named Boys
  Republic Drive. Narrow the pattern or people stop reading the output.
- **A hold nobody can see is a drop.** An early suppression path logged "held for
  review" and created no post, so the queue stayed empty and nothing was ever
  reviewed. Every suppression must terminate somewhere a human actually looks.
- **Read the whole message before republishing any of it.** Every email from one
  alerting service ends with a per-recipient link carrying a live auth token. A
  verbatim renderer would have published a working credential.
- **Fixtures written from the same wrong source as the code prove nothing.** One
  ingester's tests passed for four days against a URL shape no real message has
  ever used, because the code and the fixtures were both written from the same
  misread page.
- **A test that is never invoked reads exactly like a test that passes.** Two
  shell suites sat outside the test glob for weeks. So did a scraper with no
  scrape group, and a merged feature whose systemd timers were never installed.
- **git protects only what it tracks.** A machine reinstall cost the database,
  the raw archive, the API key and every in-flight draft. Re-scraping recovered
  it only because the project was young enough that everything was still inside
  its source window.

---

## Non-goals

No reader-facing server runtime. No comments, accounts, or tracking. No
paywalled or substantially excerpted third-party content, only short attributed
summaries under mechanical robots.txt and ToS compliance. No claim without a
primary source behind it. No LLM output published on a model's say-so alone.

## License

MIT, see [LICENSE](LICENSE). The code is yours to take. The editorial rules are
worth reading and then deciding for yourself rather than adopting wholesale:
they encode judgment calls about a specific community, and yours is different.
