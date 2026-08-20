# nbc4-news — NBC4 Los Angeles (keyword-filtered feed)

Probed 2026-08-19. Operator decision same day: ingest with a Chino keyword
filter, superseding the same-day recon rejection (which was based on 0/53
relevant items in the general feed — true, but the filter makes the firehose
harmless and the rare Chino item valuable).

- **Feed:** `https://www.nbclosangeles.com/?rss=y&most_recent=y` — this EXACT
  URL is explicitly `Allow`ed in robots.txt; the plain `?rss=y` variant is
  not the allowed form. Rolling same-day window (~25 items, all within one
  day on probe day), full article text in the item `description` element.
- **Filter:** `\bchino(\s+hills)?\b` (case-insensitive, word-boundary) on
  title + HTML-stripped description, applied at ingest — non-matching items
  are never stored. 0-item runs are the norm (zeroItemsIsHealthy).
- **Storage rule:** only the sentence-bounded teaser is stored, never the
  full body (copyright limit; the feed hands us whole articles).
- **ToS:** nbcuniversal.com/terms (sha256 888cc58e…) reviewed 2026-08-19 —
  no automated-access/scraping/RSS clause of any kind; the only "aggregate"
  hit is the liability cap. Weekly drift check covers it.
- **Expectation:** NBC4's Chino coverage skews crime/accidents, which the
  policy filter excludes from auto-published headlines. Low surfaced volume
  is the design, not a defect.
