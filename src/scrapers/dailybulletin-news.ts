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
import { DAILY_BULLETIN_ARTICLE_PATH_RE } from "./press-paths.ts";
import type { ScraperDef } from "./types.ts";

const BASE_URL = "https://www.dailybulletin.com";
const MAX_ARTICLES_PER_RUN = 15;
const OUTLET = "Daily Bulletin";

// WordPress appends " – Daily Bulletin" to every <title>.
const TITLE_SUFFIX_RE = /\s*–\s*Daily Bulletin.*$/i;

const isArticlePath = (pathname: string): boolean =>
	DAILY_BULLETIN_ARTICLE_PATH_RE.test(pathname);

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
	return collectArticleLinks(html, BASE_URL, isArticlePath).map((url) =>
		url.endsWith("/") ? url : `${url}/`,
	);
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
		// A location hub is a paginated archive, not a live feed — it carries
		// older stories on a slow news day. Every hub coming back with nothing is
		// the outlet being unreachable or its markup having moved, and reporting
		// either as a `success` run with 0 items is what hid chinohills-swagit's
		// six-day outage.
		//
		// Which of the two it was is NOT asserted here. Both end the same way: a
		// hub that 404s and a hub whose markup changed both leave `candidates`
		// empty, because each hub's fetch failure is caught and noted above. The
		// notes carry the evidence; this only has to fail.
		if (candidates.length === 0) {
			throw new Error(
				`No candidate articles found across any of the ${LOCATION_HUBS.length} location hub(s) — ` +
					"the hubs were unreachable, or their markup has changed. See this run's notes for which.",
			);
		}

		await ingestArticles(
			ctx,
			candidates.slice(0, MAX_ARTICLES_PER_RUN),
			(html, url, candidate) =>
				extractDailyBulletinMetadata(html, url, candidate.city),
			isArticlePath,
		);
	},
};

export default dailyBulletinNewsScraper;
