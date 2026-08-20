// Bulldog Times — Ayala High School's student paper (Chino Hills). One feed,
// one fetch per run. meta.city = "Chino Hills" makes items inherently local
// via isLocallyRelevant's meta.city path. Feed has been dormant since
// 2026-05-21 (verified 2026-08-19) — a 0-item run is the expected state.
import { runFeedPress } from "./feed-press.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "bulldogtimes-news",
	name: "Bulldog Times (Ayala High School)",
	baseUrl: "https://ayalabulldogtimes.org",
	method: "rss",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["ayalabulldogtimes.org", "www.ayalabulldogtimes.org"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		await runFeedPress(ctx, {
			outlet: "Bulldog Times",
			feedUrl: "https://ayalabulldogtimes.org/feed/",
			extraMeta: { city: "Chino Hills" },
		});
	},
};

export default scraper;
