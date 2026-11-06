// San Bernardino County Sentinel. A county-wide weekly, so ingest reads its
// WordPress search feed for Chino rather than the main feed, whose ten items a
// single Friday issue can fill. The search also returns legal notices that
// merely name Chino; the keyword filter drops those.
import { chinoKeywordFilter, runFeedPress } from "./feed-press.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "sbcsentinel-news",
	name: "San Bernardino County Sentinel",
	baseUrl: "https://sbcsentinel.com",
	method: "rss",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["sbcsentinel.com", "www.sbcsentinel.com"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		await runFeedPress(ctx, {
			outlet: "SBC Sentinel",
			feedUrl: "https://sbcsentinel.com/search/chino/feed/rss2/",
			filterItem: chinoKeywordFilter,
		});
	},
};

export default scraper;
