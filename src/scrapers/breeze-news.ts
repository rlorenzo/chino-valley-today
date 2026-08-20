// The Breeze — Chaffey College's student paper (Rancho Cucamonga-centric). No
// fixed city tag: unlike the two high-school papers, Chaffey's coverage area
// is not itself local, so only text-matched Chino items should surface —
// isLocallyRelevant falls through to its geo-alias path on title/body for
// this source. Bursty cadence with ~7-week summer gaps is normal.
import { runFeedPress } from "./feed-press.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "breeze-news",
	name: "The Breeze (Chaffey College)",
	baseUrl: "https://thebreezepaper.com",
	method: "rss",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["thebreezepaper.com", "www.thebreezepaper.com"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		await runFeedPress(ctx, {
			outlet: "The Breeze",
			feedUrl: "https://thebreezepaper.com/feed/",
		});
	},
};

export default scraper;
