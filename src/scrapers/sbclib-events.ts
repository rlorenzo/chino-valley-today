// Phase 4 Task 4.1 — San Bernardino County Library events, Chino Valley branches.
//
// CRITICAL HOST NOTE: the library's primary hostname sbclib.org sits behind an
// aggressive Cloudflare WAF that 403s scripted AND real-browser probes (verified
// 2026-08-17, including a temporary IP flag triggered by two curl requests). The
// identical WordPress serves openly at library.sbcounty.gov, whose robots.txt
// disallows only /wp-admin/ — same trusted county infrastructure as the already-
// ingested wp.sbcounty.gov/sheriff. NEVER point this scraper at sbclib.org.
//
// Venue ids verified live 2026-08-17 via /wp-json/tribe/events/v1/venues:
//   1181 Chino Branch Library                     (61 upcoming on probe day)
//   1250 James S. Thalman Chino Hills Branch      (71 upcoming)
//   1241 Cal Aero Preserve Academy Branch (Chino) (20 upcoming)
// Age-group categories ("Library Beginners (0-5 years)", "Kids Zone (6-11
// years)", "Families (all ages)", "Adults (18+)") ride along in meta.categories.

import { runTribeEvents } from "./tribe-events.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "sbclib-events",
	name: "SB County Library Events (Chino Valley branches)",
	baseUrl: "https://library.sbcounty.gov",
	method: "api",
	async run(ctx) {
		await runTribeEvents(ctx, {
			host: "library.sbcounty.gov",
			venues: [
				{ id: 1181, label: "Chino Branch Library" },
				{ id: 1250, label: "James S. Thalman Chino Hills Branch Library" },
				{ id: 1241, label: "Cal Aero Preserve Academy Branch Library" },
			],
		});
	},
};

export default scraper;
