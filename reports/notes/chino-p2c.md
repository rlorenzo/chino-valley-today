# chino-p2c — Chino PD "Police to Citizen" portal (probe only, NOT ingested)

Probed 2026-08-17 while investigating why `/topics/safety/` was empty. Chino
Police Department is a **municipal department**, not a Sheriff contract city, so
none of its news ever reaches the SBSD Nixle channels that feed
`sbsheriff-nixle-mail`. Chino Hills is the contract city; Chino is not. That
asymmetry is the reason this portal was worth a look at all.

`p2c.cityofchino.org` runs CentralSquare's P2C product — the vendor platform
that, when its modules are enabled, publishes daily bulletins, event/call
search, arrest and warrant listings as structured data.

**Finding: the data modules are switched off. Only online incident reporting is
live.** This is a publishing decision by the city, not a technical or policy
barrier — which makes it a gap worth *asking* about rather than working around.

## robots.txt — permissive

```text
User-Agent: *
Disallow: /admin/
```

Nothing here blocks any data path. Contrast with the ABC and CVUSD blockers in
this registry: those are policy walls, this is an empty room.

## Endpoint probe log (2026-08-17)

| URL | Result | Reading |
| --- | --- | --- |
| `/main.aspx` | 200 | Homepage. Nav shows only HOME and REPORT INCIDENT. |
| `/summary.aspx` | 302 → `/main.aspx` | Event search — module present in the build, **disabled** |
| `/dailybulletin.aspx` | 302 → `/main.aspx` | Daily bulletin — module present, **disabled** |
| `/reportincident/incidententryintro.aspx` | 200 | The only live module (citizen report filing) |
| `/jqHandler.ashx?op=s` | **200** `{"total":"0","page":"1","records":"0","rows":[]}` | jqGrid data backend, alive, zero records |
| `/arrest.aspx` | 302 → `/PageNotFound.aspx` | Not installed |
| `/warrants.aspx` | 302 → `/PageNotFound.aspx` | Not installed |
| `/inmate.aspx` | 302 → `/PageNotFound.aspx` | Not installed |
| `/cadcalls.aspx` | 302 → `/PageNotFound.aspx` | Not installed |
| `/sexoffender.aspx` | 302 → `/PageNotFound.aspx` | Not installed |
| `/admin/login.aspx` | — | Not probed; robots-disallowed and none of our business |

Two distinct 302 targets carry real information and should not be conflated:

- **→ `/main.aspx`** = the module ships in this deployment but is turned off.
  These are the ones a city configuration change could light up.
- **→ `/PageNotFound.aspx`** = the module is not installed at all. Enabling
  those would require the city to license/deploy them, a bigger ask.

The homepage markup still contains tiles linking to `summary.aspx` and
`dailybulletin.aspx` (`class="p2c-homelink p2c-eventSearch"` and
`p2c-dailyBulletin`). Those tiles are vestigial template markup pointing at
disabled features — they are what makes the portal *look* like it might carry
data. Anyone re-probing this later will see them and should not re-derive the
same dead end.

`jqHandler.ashx` is the interesting artifact: it answers with a well-formed
jqGrid JSON envelope rather than an error or a redirect, which is consistent
with the handler being wired but its backing module disabled. If the city ever
enables the daily bulletin or event search, this endpoint is very likely where
clean JSON would appear — a materially better Chino PD source than the
teaser-only CivicAlerts path we use today.

## Why this matters to the product

Current Chino PD coverage is `chino-news-rss` only: CivicAlerts "Police
Spotlights" plus the Police Department calendar category (Task 0.9 finding).
That is outreach and events — community engagement content, not incident
information. There is no incident-level Chino PD source in the registry, and
this probe confirms none is publicly reachable.

So the safety topic's realistic ceiling right now:

| City | Agency | Channel | Status |
| --- | --- | --- | --- |
| Chino Hills | SBSD contract station | Nixle email subscription | Working; station posts rarely |
| Chino | Chino PD (municipal) | — | **No incident source exists** |

## Remedy — ask, don't work around

Same shape as the CVUSD agenda-PDF and Chino Hills Laserfiche gaps: the content
is a public record, the obstacle is a publishing choice, and the correct move is
to ask the agency. Concretely: ask Chino PD's PIO (or via the City Clerk)
whether the P2C **daily bulletin** and **event search** modules can be enabled
for public view. Many California agencies run them openly. Nothing here should
be scraped into existence in the meantime — there is nothing to scrape.

Not registered as a source. Revisit if the city responds.
