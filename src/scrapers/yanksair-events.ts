// Phase 4 Task 4.1 — Yanks Air Museum events (Chino Airport).
//
// yanksair.org: WordPress + Tribe Events. robots.txt lives at
// www.yanksair.org/robots.txt (the bare hostname 404s the file): wp-admin only,
// plus `Crawl-delay: 10` — honored via extraRequestGapMs on top of
// politeFetch's 2s/host floor. REST API verified live 2026-08-17 (4 upcoming,
// listed through mid-2027: Coffee With a Cop, Veterans Day free admission).
// Whole calendar ingested — the museum is in Chino, everything is local.

import { runTribeEvents } from "./tribe-events.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "yanksair-events",
	name: "Yanks Air Museum Events (Chino Airport)",
	baseUrl: "https://yanksair.org",
	method: "api",
	async run(ctx) {
		await runTribeEvents(ctx, {
			host: "yanksair.org",
			// robots.txt requests Crawl-delay: 10; politeFetch floors at 2s, so add
			// the remaining 8s between any paginated requests to this host.
			extraRequestGapMs: 8000,
			// Sparse calendar (single-digit upcoming events); a wider lookback keeps
			// recently-passed events visible for recap purposes between runs.
			lookbackDays: 7,
		});
	},
};

export default scraper;
