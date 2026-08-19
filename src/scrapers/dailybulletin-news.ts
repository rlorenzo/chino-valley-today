// Scraper for Inland Valley Daily Bulletin (dailybulletin.com) on MediaNews Group WordPress.
// Discovers articles via dedicated Chino and Chino Hills municipal location hubs.
// Bounded to 15 articles total per run.
// Extracts Tier A deterministic title, sentence-truncated teaser, and local relevance metadata.

import { isLocallyRelevant } from "../gates/policy-filters.ts";
import { errorMessage } from "../utils/errors.ts";
import {
	type ArticleCandidate,
	collectArticleLinks,
	ingestArticles,
	type PressArticle,
	parseArticleHead,
} from "./press-article.ts";
import type { ScraperDef } from "./types.ts";

const BASE_URL = "https://www.dailybulletin.com";
const MAX_ARTICLES_PER_RUN = 15;
const OUTLET = "Daily Bulletin";

// WordPress appends " – Daily Bulletin" to every <title>.
const TITLE_SUFFIX_RE = /\s*–\s*Daily Bulletin.*$/i;

// WordPress permalinks: /YYYY/MM/DD/slug/
const ARTICLE_PATH_RE = /^\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\/?$/;

const LOCATION_HUBS = [
	{
		city: "Chino",
		url: `${BASE_URL}/location/california/san-bernardino-county/chino/`,
	},
	{
		city: "Chino Hills",
		url: `${BASE_URL}/location/california/san-bernardino-county/chino-hills/`,
	},
];

export function parseLocationHub(html: string): string[] {
	return collectArticleLinks(html, BASE_URL, (pathname) =>
		ARTICLE_PATH_RE.test(pathname),
	).map((url) => (url.endsWith("/") ? url : `${url}/`));
}

export function extractDailyBulletinMetadata(
	html: string,
	url: string,
	city?: string,
): PressArticle {
	const { title, teaser, occurredAt } = parseArticleHead(html, TITLE_SUFFIX_RE);
	const rel = isLocallyRelevant({ title, body: teaser, meta: { city } });

	return {
		external_id: new URL(url).pathname.replace(/^\/|\/$/g, ""),
		title,
		body: teaser,
		occurred_at: occurredAt,
		meta: {
			outlet: OUTLET,
			city: city ?? "Chino",
			chinoRelevant: rel.relevant,
			relevanceEvidence: rel.evidence,
		},
	};
}

const dailyBulletinNewsScraper: ScraperDef = {
	key: "dailybulletin-news",
	name: "Inland Valley Daily Bulletin",
	baseUrl: BASE_URL,
	method: "html",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["www.dailybulletin.com", "dailybulletin.com"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		ctx.note("Starting Daily Bulletin location feed discovery");
		const candidates: ArticleCandidate[] = [];
		const seenUrls = new Set<string>();

		for (const hub of LOCATION_HUBS) {
			try {
				ctx.note(`Fetching location hub: ${hub.url}`);
				const res = await ctx.fetchRaw(hub.url);
				if (res.ok) {
					for (const url of parseLocationHub(res.body.toString("utf8"))) {
						// First hub to link an article wins its city tag; the Chino and
						// Chino Hills hubs overlap on stories that mention both.
						if (seenUrls.has(url)) continue;
						seenUrls.add(url);
						candidates.push({ url, city: hub.city });
					}
				}
			} catch (err) {
				ctx.note(
					`Failed to fetch location hub ${hub.url}: ${errorMessage(err)}`,
				);
			}
		}

		ctx.note(
			`Discovered ${candidates.length} candidate Daily Bulletin articles`,
		);
		if (candidates.length === 0) return;

		await ingestArticles(
			ctx,
			candidates.slice(0, MAX_ARTICLES_PER_RUN),
			(html, url, candidate) =>
				extractDailyBulletinMetadata(html, url, candidate.city),
		);
	},
};

export default dailyBulletinNewsScraper;
