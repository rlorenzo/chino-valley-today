# ktla — REJECTED on ToS (2026-08-19)

Two probes, one day apart in conclusion:

1. First pass: `/tag/chino-hills/feed/` (the geo-targeted feed) is
   robots-blocked — `Disallow: /tag/` under `User-agent: *`, a mechanical
   block for every client, not an AI-crawler rule. Homepage 403'd the
   pipeline UA (PerimeterX-style challenge).
2. Second pass: `/feed/` (LA-wide) turned out to be robots-PERMITTED and
   live-fetchable (HTTP 200, valid RSS, 20 items, 0 Chino mentions) — the
   403 wall guards HTML pages only. So a keyword-filtered ingest looked
   mechanically possible…
3. …until the ToS read. ktla.com's footer links
   `nexstar.tv/terms-of-use/` (the station's own /terms-of-service/ path
   404s; the footer link was read via a one-time human-browser session
   because KTLA's HTML 403s bot clients — same out-of-band precedent as the
   Chino RSS catalog). nexstar.tv is robots-open and the terms fetched
   cleanly (sha256 686cbbc9…). The terms expressly prohibit: any
   robot/spider "for any purpose"; "data gathering or data extraction
   practices for any purpose"; AI use of content; personal noncommercial
   use only; no reproduction/distribution without written permission.

That is a binding ToS prohibition on automated ingestion of any kind —
Nixle class. Rejected regardless of robots posture. Do not revisit without
a change in Nexstar's terms.
