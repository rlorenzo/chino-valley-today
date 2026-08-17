// Phase 4 Task 4.1 — Chino Basin Water Conservation District classes & events.
//
// cbwcd.org: WordPress + Tribe Events, robots.txt fully open (Yoast default,
// empty Disallow). REST API verified live 2026-08-17 (20 upcoming: Water
// Wednesdays, compost giveaways, DIY landscape/water-feature workshops — free
// community programming squarely aimed at Chino Valley residents). The site
// also offers ICS export; the REST API is used here for structured categories
// and per-occurrence ids. Whole calendar ingested — the district IS the
// coverage area, no venue filter needed.

import { runTribeEvents } from "./tribe-events.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "cbwcd-events",
	name: "Chino Basin Water Conservation District Events",
	baseUrl: "https://cbwcd.org",
	method: "api",
	async run(ctx) {
		await runTribeEvents(ctx, { host: "cbwcd.org" });
	},
};

export default scraper;
