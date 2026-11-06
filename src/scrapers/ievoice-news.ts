// IE Voice. A regional Inland Empire outlet, so ingest reads its WordPress
// search feed for Chino. This is the path form on purpose: robots.txt disallows
// every URL with a query string (`Disallow: /*?`), so `?s=chino&feed=rss2` is
// not an equivalent.
import { chinoKeywordFilter, runFeedPress } from "./feed-press.ts";
import type { ScraperDef } from "./types.ts";

const scraper: ScraperDef = {
	key: "ievoice-news",
	name: "IE Voice",
	baseUrl: "https://theievoice.com",
	method: "rss",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["theievoice.com", "www.theievoice.com"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		await runFeedPress(ctx, {
			outlet: "IE Voice",
			feedUrl: "https://theievoice.com/search/chino/feed/rss2/",
			filterItem: chinoKeywordFilter,
		});
	},
};

export default scraper;
