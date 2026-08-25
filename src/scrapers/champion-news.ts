// Scraper for The Chino Valley Champion (championnewspapers.com) on TownNews Blox CMS.
// Discovers articles via Saturday edition sitemaps, bounded to 15 articles per run.
// Extracts Tier A deterministic title, sentence-truncated teaser, and local relevance metadata.

import { XMLParser } from "fast-xml-parser";
import { isLocallyRelevant } from "../gates/policy-filters.ts";
import { errorMessage } from "../utils/errors.ts";
import {
	type ArticleCandidate,
	collectArticleLinks,
	ingestArticles,
	type PressArticle,
	parseArticleHead,
} from "./press-article.ts";
import { CHAMPION_ARTICLE_PATH_RE } from "./press-paths.ts";
import type { ScraperDef } from "./types.ts";

const BASE_URL = "https://www.championnewspapers.com";
const SITEMAP_INDEX_URL = `${BASE_URL}/tncms/sitemap/editorial.xml`;
const MAX_ARTICLES_PER_RUN = 15;
const OUTLET = "The Champion";

// The CMS appends " | The Champion[ Newspapers]" to every <title>.
const TITLE_SUFFIX_RE = /\s*\|\s*The Champion.*$/i;

const isArticlePath = (pathname: string): boolean =>
	CHAMPION_ARTICLE_PATH_RE.test(pathname);

const xmlParser = new XMLParser({ ignoreAttributes: true });

function locs(xml: string): string[] {
	const parsed = xmlParser.parse(xml) as Record<string, unknown>;
	const out: string[] = [];
	// Sitemap index nests <loc> under <sitemap>, urlsets under <url>; walking the
	// parsed tree covers both without caring which one this document is.
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (node && typeof node === "object") {
			for (const [key, value] of Object.entries(node)) {
				if (key === "loc" && typeof value === "string") out.push(value.trim());
				else walk(value);
			}
		}
	};
	walk(parsed);
	return out;
}

/** Edition sitemap URLs, newest edition first. */
export function parseSitemapIndex(xml: string): string[] {
	return locs(xml)
		.filter((loc) => /\/editorial\.xml\?date=\d{4}-\d{2}-\d{2}$/.test(loc))
		.sort()
		.reverse();
}

export function parseEditionSitemap(xml: string): string[] {
	return locs(xml).filter((loc) => {
		try {
			return isArticlePath(new URL(loc).pathname);
		} catch {
			return false;
		}
	});
}

export function parseHtmlCategoryIndex(html: string): string[] {
	return collectArticleLinks(html, BASE_URL, isArticlePath);
}

export function extractArticleMetadata(
	html: string,
	url: string,
): PressArticle {
	const { title, teaser, occurredAt } = parseArticleHead(html, TITLE_SUFFIX_RE);

	const pathname = new URL(url).pathname;
	const idMatch = pathname.match(CHAMPION_ARTICLE_PATH_RE);
	const rel = isLocallyRelevant({ title, body: teaser });

	return {
		external_id: idMatch ? `article_${idMatch[1]}` : url,
		title,
		body: teaser,
		occurred_at: occurredAt,
		meta: {
			outlet: OUTLET,
			section: pathname.split("/")[1] || "community_news",
			chinoRelevant: rel.relevant,
			relevanceEvidence: rel.evidence,
		},
	};
}

/** Latest edition sitemap first; category indexes only if that yields nothing. */
async function discoverCandidateUrls(
	ctx: Parameters<ScraperDef["run"]>[0],
): Promise<string[]> {
	try {
		const sitemapRes = await ctx.fetchRaw(SITEMAP_INDEX_URL);
		if (sitemapRes.ok) {
			const [latestEditionUrl] = parseSitemapIndex(
				sitemapRes.body.toString("utf8"),
			);
			if (latestEditionUrl) {
				ctx.note(`Fetching latest edition sitemap: ${latestEditionUrl}`);
				const editionRes = await ctx.fetchRaw(latestEditionUrl);
				if (editionRes.ok) {
					const urls = parseEditionSitemap(editionRes.body.toString("utf8"));
					if (urls.length > 0) return urls;
				}
			}
		}
	} catch (err) {
		ctx.note(
			`Sitemap discovery failed: ${errorMessage(err)}, trying fallback category indexes`,
		);
	}

	ctx.note("Using category index fallback for Champion discovery");
	const fallback = new Set<string>();
	for (const path of ["/news/", "/community_news/"]) {
		try {
			const catRes = await ctx.fetchRaw(`${BASE_URL}${path}`);
			if (catRes.ok) {
				for (const url of parseHtmlCategoryIndex(
					catRes.body.toString("utf8"),
				)) {
					fallback.add(url);
				}
			}
		} catch (err) {
			ctx.note(`Category index ${path} fetch failed: ${errorMessage(err)}`);
		}
	}
	return [...fallback];
}

const championNewsScraper: ScraperDef = {
	key: "champion-news",
	name: "The Champion Newspapers",
	baseUrl: BASE_URL,
	method: "html",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["www.championnewspapers.com", "championnewspapers.com"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		ctx.note("Starting Champion Newspapers discovery");
		const candidateUrls = await discoverCandidateUrls(ctx);

		ctx.note(`Discovered ${candidateUrls.length} candidate article URLs`);
		// Zero candidates means the edition sitemap AND both category-index
		// fallbacks came back empty — three independent ways of listing a weekly
		// paper's articles, all silent. That is a broken discovery path, not a
		// quiet week, and it must not record a `success` run with 0 items.
		if (candidateUrls.length === 0) {
			throw new Error(
				`Discovery found no candidate article URLs at all (${SITEMAP_INDEX_URL} and both category indexes) — ` +
					"the sitemap or the category markup has probably changed.",
			);
		}

		const candidates: ArticleCandidate[] = candidateUrls
			.slice(0, MAX_ARTICLES_PER_RUN)
			.map((url) => ({ url }));

		await ingestArticles(
			ctx,
			candidates,
			extractArticleMetadata,
			isArticlePath,
		);
	},
};

export default championNewsScraper;
