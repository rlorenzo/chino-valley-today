# Source Dossier: Inland Valley Daily Bulletin (`dailybulletin-news`)

**Canonical Name:** Inland Valley Daily Bulletin  
**Publisher:** MediaNews Group / Southern California News Group (SCNG)  
**Platform:** WordPress (Custom MediaNews Group Stack)  
**Base URL:** `https://www.dailybulletin.com`  
**Publication Cadence:** Daily continuous online reporting.  
**Ingestion Method:** `html` scraper with municipal location hub discovery.  
**Scraper Key:** `dailybulletin-news`  

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

- **Terms URL:** `https://www.medianewsgroup.com/terms-of-use/` (Canonical parent terms for Daily Bulletin / SCNG)
- **Reviewed SHA256:** `d48be59531c05ad31906a5d59c5d72533e14c3595f7345afdd2d3d066870fea5`
- **Reviewer:** `rexl` (2026-08-18)
- **Robots.txt Policy:** `failClosedRobots: true`
- **Redirect Policy:** `manualRedirect: true`, `allowedHosts: ["www.dailybulletin.com", "dailybulletin.com"]`, `maxRedirectHops: 3`.
- **Drift Monitoring:** Monitored weekly via `scripts/check-tos-drift.ts` (systemd `cvt-check-tos.timer`). Any hash change or fetch error atomically holds the source (`source_tos_status.status = 'held'`).

---

## 2. Technical Ingestion Pipeline

### 2.1 Discovery Mechanism

1. The scraper fetches two dedicated municipal location hubs:
   - `https://www.dailybulletin.com/location/california/san-bernardino-county/chino/`
   - `https://www.dailybulletin.com/location/california/san-bernardino-county/chino-hills/`
2. Extracts candidate article URLs matching:
   `^https://www\.dailybulletin\.com/\d{4}/\d{2}/\d{2}/[a-z0-9-]+/?$`
3. Deduplicates URLs across both hubs.
4. Bounded fetch: Caps candidate retrieval to a maximum of 15 articles total per run.

### 2.2 Extraction & Metadata

- `external_id`: Normalized URL path slug (e.g. `YYYY/MM/DD/article-slug`).
- `title`: Extracted from `og:title`, `<h1 class="entry-title">`, or `<title>`, cleaned of trailing `– Daily Bulletin`.
- `body`: Sentence-bounded teaser from `og:description` or meta description.
- `occurred_at`: Published timestamp from `article:published_time` or `<time>` tags.
- `meta`:
  - `outlet`: `"Daily Bulletin"`
  - `city`: `"Chino"` or `"Chino Hills"` depending on discovery hub
  - `chinoRelevant`: boolean determined by `isLocallyRelevant`

---

## 3. Daily Brief Selection Gate

- **Freshness Window:** Scrape run must be successful and $\le 26$ hours old.
- **Recency Window:** Article `occurred_at` must be within 48 hours relative to brief assembly time (and strictly after `prevBriefPublishedAt` when present).
- **Policy Gate:** Evaluated by `filterHeadlineEligibility()`:
  - Fails closed on unvetted private individuals (unless in `PUBLIC_FIGURE_ALLOWLIST` or `CIVIC_ENTITIES_ALLOWLIST`).
  - Rejects crime, active law enforcement investigations, blotters, and minors.
- **Cross-Outlet Deduplication:** Evaluated against Champion articles using Jaccard token similarity ($\ge 0.60$). If duplicate, Champion article is preserved.
- **Capping:** Max 3 articles from Daily Bulletin, within a global cap of 5 total headlines elsewhere.
