# nws-forecast — NWS gridpoint daily forecast (Phase 4 Task 4.1)

Added 2026-08-17 as the daily brief's "always have something" anchor. Extends
the nws-alerts integration (same API, same UA requirement, same skipRobots
justification — api.weather.gov's blanket crawler Disallow does not target
documented API clients).

## Method

- `/points/33.99,-117.69` → Chino gridpoint `SGX/47,73`
- `/points/33.95,-117.73` → Chino Hills gridpoint `SGX/45,71`
- Ingested endpoint per city: `/gridpoints/<grid>/forecast` (12h periods,
  ~14 per response). Hourly endpoint exists (`/forecast/hourly`) but is not
  ingested — period granularity fits the brief; revisit if a widget needs it.

## Item design

- `item_type` `forecast_period`, one item per period.
- `external_id` = `<grid>:<period start ISO>`, so both cities coexist and
  re-runs UPDATE in place (insertItem's identity is document url + item_type +
  external_id) — forecasts churn on every NWS update cycle and must refresh,
  not accumulate.
- `source_url` = the city's forecast.weather.gov MapClick page (reader-facing;
  the API URL serves JSON and is recoverable from `meta.grid`). Document-level
  link-back — no period-level anchor exists on MapClick.
- meta: temperature/unit, wind, PoP, shortForecast, isDaytime, endTime, city,
  grid.

## First run (2026-08-17)

28 items (14 periods × 2 cities), both fetches clean. ETag supported (same
HTTP behavior as nws-alerts). Scheduled in the `frequent` group — hourly
polling with conditional GET is well inside NWS politeness expectations.
