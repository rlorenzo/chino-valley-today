# usgs-quakes — USGS earthquakes near the Chino Valley

Added 2026-09-02. Raised by the operator the morning a M3.4 near Ontario woke
the area at 05:37 PT and reached every phone in town, while this site had
nothing to say about it: the registry had no seismic source at all.

## Method

USGS FDSN event web service, the standard federal earthquake catalog API.

```text
GET https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson
    &latitude=33.97&longitude=-117.71&maxradiuskm=50
    &minmagnitude=2.5&starttime=<YYYY-MM-DD>&orderby=time
```

The centre point is the midpoint of the two city centres the pipeline already
uses for NWS gridpoints (Chino 33.99,-117.69 and Chino Hills 33.95,-117.73).
They are 4.5 km apart, so one ring covers both and a second request would buy
nothing.

### Access posture

- Output is a US Government work: public domain, no licence terms, no
  attribution obligation, no ToS gate entry needed (same posture as
  `nws-forecast`).
- `earthquake.usgs.gov/robots.txt` returns **404** (checked 2026-09-02). There
  is no crawler policy to interpret, so unlike api.weather.gov this source needs
  no `skipRobots` flag and carries no justification burden.
- Runs in the `frequent` group (hourly). One small request per hour against a
  federal API built for programmatic use.

## Choosing the thresholds

The task note proposed "M2.5 within 50 km" as an explicit guess. It was checked
before shipping, against every M2.0+ event within 50 km in the year to
2026-09-02: 65 events.

| Ring | M2.5+ | M3.0+ |
| --- | --- | --- |
| 30 km | 5/yr | 2/yr |
| 50 km | 27/yr | 10/yr |

Counts alone do not settle it. Two things the per-event data showed:

**Magnitude alone is a bad relevance filter.** The 50 km ring's eastern edge is
the Loma Linda / Redlands swarm, 44 to 50 km out, which by itself produced eight
M2.5+ events in the year including four above M3.0 (M3.23, M3.23, M3.13, M3.14).
Those are San Bernardino stories. A pure magnitude gate would have filled the
brief with them.

**Distance is the signal that matters.** Of the four M2.5+ events within 25 km
of a city centre, every single one drew a large "Did You Feel It" response:

| Date | Mag | km from nearest city | DYFI reports | USGS place |
| --- | --- | --- | --- | --- |
| 2025-09-07 | M3.41 | 24.6 | 549 | 10 km N of La Verne |
| 2026-05-02 | M2.54 | 11.8 | 151 | 5 km SE of Ontario |
| 2026-08-12 | M3.04 | 15.8 | 402 | 10 km WSW of Corona |
| 2026-08-16 | M2.78 | 12.1 | 128 | 6 km SE of Ontario |

(Distances in that table are from the ring centre, as the probe measured them;
the scraper measures from the nearer of the two city centres, so its numbers run
slightly lower.)

Not one of those four was noise, and none of them would have been caught by a
30 km ring at a higher magnitude floor. So the rule is: **search wide, flag
close.**

- Search: M2.5+ within 50 km, roughly 27 events a year ingested.
- Flag `meta.chinoRelevant`: within 25 km of either city centre, roughly 4 a
  year, or M4.0+ anywhere in the ring.

The M4.0+ clause never fired in the sampled year. It exists because that year
contained nothing above M3.5 to calibrate against, and a genuinely large quake
40 km out would be the biggest local story of the year. A threshold tuned on
small events must not be the thing that drops it.

## Item design

- `item_type` `alert`, reusing the existing type rather than minting one. The
  brief's Fire & safety section renders exactly what a quake line needs, title
  plus source link and no body, and `src/tiera/alerts.ts` cannot accidentally
  generate an alert post from these because it requires a future `meta.ends`,
  which a quake never has.
- `external_id` = the USGS event id (`ci41540608`), taken from the feature's own
  `id`. Note `properties.ids` lists the same event under several networks
  (`,ci41540608,us7000tdmq,`); the feature id is the canonical one.
- `source_url` = `properties.url`, the reader-facing event page. Item-level
  link-back, the strongest tier in the registry. Unlike `nws-alerts` there is a
  real human page at the other end, so the archive-page citation workaround is
  not needed here.
- `occurred_at` from `properties.time` (epoch ms).
- No body. Fire & safety renders titles only, and USGS supplies no narrative
  text anyway.

## Quirks

**Magnitudes get revised, and the first number is the one that reaches phones.**
The 2026-09-02 event was distributed as M3.36 and settled at M3.2 with
`status: "reviewed"` eleven hours later. Two mitigations: titles read
"Preliminary M x.x ..." while status is anything other than `reviewed`, and the
query window is 7 days, so an event stays in range while USGS revises it and the
revision lands as an in-place item update. The brief runs at 06:00, so an event
from the small hours can still be preliminary when it is first published; the
title says so, and the citation goes to the event page, which always shows the
current value.

**`place` is nearest-city and never says Chino.** "6 km SE of Ontario, CA" is
the whole of what USGS says about location. Chino relevance therefore comes from
the radius query and the coordinates, never from string matching, and the title
states distance from Chino as our own computed claim while quoting USGS's
wording verbatim in the parenthetical.

**`metadata.generated` is a fresh epoch stamp on every request.** Documents are
content-addressed, so without intervention an hourly timer would mint 24
identical archive files a day, forever. The scraper passes a `stripVolatile`
that replaces that one field with a `STRIPPED-BY-CHINO-VALLEY-TODAY` sentinel,
following the precedent `stripCsrfToken` set in `chinohills-sports.ts`: the
archive is the record of what a source said, so a redaction in it has to be
visible as one rather than left looking like a real value. The query echo, the
count and every feature survive, so what is archived is still the full answer
USGS gave. `starttime` is at date
granularity for the same reason: an ISO-timestamp start would change the URL on
every run, and nothing would ever hash-match.

## Alternatives considered

The fixed real-time GeoJSON feeds (`/earthquakes/feed/v1.0/summary/all_day.geojson`
and friends) are simpler URLs but global, so they would need the same distance
filtering client-side plus a much larger download. The radius query does the
work server-side. No reason to prefer the feeds.
