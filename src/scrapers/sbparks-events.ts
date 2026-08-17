// Phase 4 Task 4.1 — SB County Regional Parks events at Prado Regional Park.
//
// parks.sbcounty.gov runs the same WordPress + Tribe Events setup as the
// library and sheriff sites; robots.txt disallows only /wp-admin/. Venue id
// 1897 (Prado Regional Park) verified live 2026-08-17 — the REST probe returned
// real events with stable /event/<slug>/<date>/ permalinks. Prado is the only
// regional park in the Chino Valley coverage area, so this scraper is
// venue-scoped rather than county-wide.

import { runTribeEvents } from "./tribe-events.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "sbparks-events",
	name: "SB County Regional Parks Events (Prado Regional Park)",
	baseUrl: "https://parks.sbcounty.gov",
	method: "api",
	async run(ctx) {
		await runTribeEvents(ctx, {
			host: "parks.sbcounty.gov",
			venues: [{ id: 1897, label: "Prado Regional Park" }],
			// Prado programming is sparse (a handful of upcoming events); look a bit
			// further back so seasonal festivals stay visible between runs.
			lookbackDays: 7,
		});
	},
};

export default scraper;
