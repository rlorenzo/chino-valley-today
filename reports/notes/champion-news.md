# Source Dossier: The Champion Newspapers (`champion-news`)

**Canonical Name:** The Chino Champion / Chino Hills News  
**Publisher:** Champion Newspapers  
**Platform:** TownNews Blox CMS  
**Base URL:** `https://www.championnewspapers.com`  
**Publication Cadence:** Weekly print edition published on Saturdays, online updates throughout the week.  
**Ingestion Method:** `html` scraper with XML sitemap discovery.  
**Scraper Key:** `champion-news`  

---

## 1. Editorial and Legal Invariants

### 1.1 Provenance and Attribution

- Secondary community press coverage is ingested to provide readers with "Headlines elsewhere" pointers in the daily brief.
- Secondary press links represent **attribution**, not primary civic provenance.
- Secondary links are placed in frontmatter `attributions: []` (never `sources: []`) and rendered using `.stamp--attribution` wearing crate styling (`var(--crate)`), strictly avoiding violet ink (`var(--stamp)`).

### 1.2 Copyright and Summarization

- Per `EDITORIAL.md` "Secondary press (amended 2026-08-17)":
  - Titles are ingested verbatim.
  - Teasers are extracted from meta descriptions and deterministically capped to sentence boundaries ($\le 280$ chars, $\le 40$ words) via `truncateToSentenceBoundary()`.
  - Article bodies are never substantially reproduced or excerpted.

### 1.3 Terms of Service and Compliance

- **Terms URL:** `https://www.championnewspapers.com/site/terms.html`
- **Reviewed SHA256:** `b00ff0478d29955b84a444af610933d1d9e29a93c00e68e3a19b254119e587d4`
- **Reviewer:** `rexl` (2026-08-18)
- **Robots.txt Policy:** `failClosedRobots: true`
- **Redirect Policy:** `manualRedirect: true`, `allowedHosts: ["www.championnewspapers.com", "championnewspapers.com"]`, `maxRedirectHops: 3`.
- **Drift Monitoring:** Monitored weekly via `scripts/check-tos-drift.ts` (systemd `cvt-check-tos.timer`). Any hash change or fetch error atomically holds the source (`source_tos_status.status = 'held'`).

---

## 2. Technical Ingestion Pipeline

### 2.1 Discovery Mechanism

1. The scraper fetches the sitemap index at `https://www.championnewspapers.com/tncms/sitemap/editorial.xml`.
2. Locates the latest Saturday edition sitemap URL matching:
   `https://www.championnewspapers.com/tncms/sitemap/editorial.xml?date=YYYY-MM-DD`
3. Parses the edition sitemap to extract article candidate URLs matching:
   `^https://www\.championnewspapers\.com/(?:community_news|news|business|sports_and_recreation)/article_[a-f0-9-]+\.html$`
4. Fallback: If sitemaps are unavailable, parses category indexes `/news/` and `/community_news/`.
5. Bounded fetch: Caps candidate retrieval to a maximum of 15 articles per run.

### 2.2 Extraction & Metadata

- `external_id`: `article_<uuid>` parsed from the URL.
- `title`: Extracted from `og:title` or `<title>`, cleaned of trailing `| The Champion`.
- `body`: Sentence-bounded teaser from `og:description` or meta description.
- `occurred_at`: Published timestamp from `datePublished` / `article:published_time`.
- `meta`:
  - `outlet`: `"The Champion"`
  - `section`: URL path segment (e.g. `community_news`, `business`)
  - `chinoRelevant`: boolean determined by `isLocallyRelevant`

---

## 3. Daily Brief Selection Gate

- **Freshness Window:** Scrape run must be successful and $\le 192$ hours (8 days) old.
- **Recency Window:** Article `occurred_at` must be within 7 days (168 hours) relative to brief assembly time.
- **Policy Gate:** Evaluated by `filterHeadlineEligibility()`:
  - Fails closed on unvetted private individuals (unless in `PUBLIC_FIGURE_ALLOWLIST` or `CIVIC_ENTITIES_ALLOWLIST`).
  - Rejects crime, active law enforcement investigations, blotters, and minors.
- **Cross-Outlet Deduplication:** Champion receives top precedence over Daily Bulletin for matching stories (Jaccard similarity $\ge 0.60$).
