// Shared extraction and ingest for the secondary community press scrapers
// (The Champion, Daily Bulletin). Both outlets run stock CMSes that publish
// Open Graph metadata in <head>, so the only genuinely per-outlet parts are URL
// discovery, the suffix the CMS appends to <title>, and the external id. Keeping
// the rest here means an EDITORIAL.md excerpt-limit change lands in one place
// instead of two that drift apart.

import * as cheerio from "cheerio";
import { errorMessage } from "../utils/errors.ts";
import {
	cleanPlainText,
	truncateToSentenceBoundary,
} from "../utils/text-truncation.ts";
import type { ScraperContext } from "./types.ts";

// EDITORIAL.md copyright & excerpt limits for secondary press teasers.
export const TEASER_MAX_CHARS = 280;
export const TEASER_MAX_WORDS = 40;

// Every article we ingest is one of these; the outlet decides the rest.
const ITEM_TYPE = "news_article";

export interface ArticleHead {
	title: string | null;
	teaser: string | null;
	occurredAt: string | null;
}

function firstNonEmpty(values: Array<string | undefined>): string | null {
	for (const value of values) {
		const cleaned = value ? cleanPlainText(value) : "";
		if (cleaned) return cleaned;
	}
	return null;
}

function metaContents(
	$: cheerio.CheerioAPI,
	selectors: string[],
): Array<string | undefined> {
	return selectors.map((selector) => $(selector).first().attr("content"));
}

/**
 * Reads headline, teaser and publish time out of an article's <head>.
 * `titleSuffixRe` strips the outlet name the CMS appends to <title>.
 */
export function parseArticleHead(
	html: string,
	titleSuffixRe: RegExp,
): ArticleHead {
	const $ = cheerio.load(html);

	const title = firstNonEmpty([
		...metaContents($, ['meta[property="og:title"]']),
		$("h1.entry-title").first().text(),
		$("title").first().text(),
	]);

	const description = firstNonEmpty(
		metaContents($, [
			'meta[property="og:description"]',
			'meta[name="description"]',
		]),
	);

	const occurredAt = firstNonEmpty([
		...metaContents($, [
			'meta[property="article:published_time"]',
			'meta[itemprop="datePublished"]',
		]),
		$("time[datetime]").first().attr("datetime"),
	]);

	return {
		title: title ? title.replace(titleSuffixRe, "").trim() || null : null,
		teaser: description
			? truncateToSentenceBoundary(
					description,
					TEASER_MAX_CHARS,
					TEASER_MAX_WORDS,
				)
			: null,
		occurredAt,
	};
}

const bareHost = (hostname: string): string => hostname.replace(/^www\./, "");

/**
 * Collects same-site links whose pathname the outlet recognizes as an article,
 * resolved against `baseUrl` so relative hrefs work. Order is preserved and
 * duplicates dropped, because discovery pages repeat links in nav rails.
 *
 * Every result is rewritten onto `baseUrl`'s own origin. Outlets link the same
 * article by both the bare and www host, and item identity is keyed on the
 * document URL — left alone, the two spellings fetch the same story twice and
 * store it as two items.
 */
export function collectArticleLinks(
	html: string,
	baseUrl: string,
	isArticlePath: (pathname: string) => boolean,
): string[] {
	const base = new URL(baseUrl);
	const $ = cheerio.load(html);
	const urls = new Set<string>();

	for (const el of $("a[href]").toArray()) {
		const href = $(el).attr("href");
		if (!href) continue;
		let url: URL;
		try {
			url = new URL(href, baseUrl);
		} catch {
			continue;
		}
		if (url.protocol !== "https:") continue;
		if (bareHost(url.hostname) !== bareHost(base.hostname)) continue;
		if (!isArticlePath(url.pathname)) continue;
		urls.add(`${base.origin}${url.pathname}`);
	}

	return [...urls];
}

export interface PressArticle {
	external_id: string;
	title: string | null;
	body: string | null;
	occurred_at: string | null;
	meta: Record<string, unknown>;
}

export interface ArticleCandidate {
	url: string;
	city?: string;
}

/**
 * Fetches, extracts and inserts each candidate. A single article failing to
 * fetch or parse is noted and skipped — one bad URL must not cost the run the
 * articles behind it.
 */
export async function ingestArticles(
	ctx: ScraperContext,
	candidates: ArticleCandidate[],
	extract: (
		html: string,
		url: string,
		candidate: ArticleCandidate,
	) => PressArticle,
): Promise<void> {
	for (const candidate of candidates) {
		try {
			const doc = await ctx.fetchDocument(candidate.url, {
				docType: ITEM_TYPE,
			});
			const url = doc.finalUrl || candidate.url;
			const article = extract(doc.body.toString("utf8"), url, candidate);
			if (!article.title) {
				ctx.note(`Skipping article without title: ${candidate.url}`);
				continue;
			}

			ctx.insertItem({
				document_id: doc.documentId,
				source_url: url,
				item_type: ITEM_TYPE,
				external_id: article.external_id,
				title: article.title,
				body: article.body,
				meta: article.meta,
				occurred_at: article.occurred_at,
			});
		} catch (err) {
			ctx.note(
				`Failed to retrieve article ${candidate.url}: ${errorMessage(err)}`,
			);
		}
	}
}
