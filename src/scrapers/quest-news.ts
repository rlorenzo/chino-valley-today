// Quest News — Don Lugo High School's student paper (Chino). One feed, one
// fetch per run; robots.txt permits /feed/ and asks Crawl-delay 6, both
// satisfied by the default poll cadence. meta.city = "Chino" makes items
// inherently local via isLocallyRelevant's meta.city path, since the school
// itself is the local anchor. Feed has been dormant since 2026-04-16
// (verified 2026-08-19) — a 0-item run is the expected state, not a fault.
import { runFeedPress } from "./feed-press.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "quest-news",
	name: "Quest News (Don Lugo High School)",
	baseUrl: "https://dalquestnews.org",
	method: "rss",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["dalquestnews.org", "www.dalquestnews.org"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		await runFeedPress(ctx, {
			outlet: "Quest News",
			feedUrl: "https://dalquestnews.org/feed/",
			extraMeta: { city: "Chino" },
		});
	},
};

export default scraper;
