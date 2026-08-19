import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import championNewsScraper, {
	extractArticleMetadata,
	parseEditionSitemap,
	parseHtmlCategoryIndex,
	parseSitemapIndex,
} from "./champion-news.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "__fixtures__");

test("champion-news scraper parsing & extraction", async (t) => {
	const sitemapIndexXml = readFileSync(
		join(fixturesDir, "champion-sitemap.xml"),
		"utf8",
	);
	const editionSitemapXml = readFileSync(
		join(fixturesDir, "champion-edition-sitemap.xml"),
		"utf8",
	);
	const articleHtml = readFileSync(
		join(fixturesDir, "champion-article.html"),
		"utf8",
	);
	const nonLocalHtml = readFileSync(
		join(fixturesDir, "champion-community-non-local.html"),
		"utf8",
	);

	await t.test("parseSitemapIndex extracts sorted edition URLs", () => {
		const editions = parseSitemapIndex(sitemapIndexXml);
		assert.equal(editions.length, 2);
		assert.equal(
			editions[0],
			"https://www.championnewspapers.com/tncms/sitemap/editorial.xml?date=2026-08-15",
		);
	});

	await t.test(
		"parseEditionSitemap filters out legal notices and non-articles",
		() => {
			const urls = parseEditionSitemap(editionSitemapXml);
			assert.equal(urls.length, 2);
			assert.equal(
				urls[0],
				"https://www.championnewspapers.com/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html",
			);
			assert.equal(
				urls[1],
				"https://www.championnewspapers.com/community_news/article_5f197cf8-0a8e-4414-b9a0-1a7511c8e7f8.html",
			);
		},
	);

	await t.test("parseHtmlCategoryIndex finds article links in HTML", () => {
		const mockHtml = `
      <a href="/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html">Link 1</a>
      <a href="/news/article_12345678-1234-1234-1234-123456789abc.html">Link 2</a>
    `;
		const urls = parseHtmlCategoryIndex(mockHtml);
		assert.equal(urls.length, 2);
		assert.equal(
			urls[0],
			"https://www.championnewspapers.com/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html",
		);
	});

	await t.test(
		"extractArticleMetadata extracts title, truncated teaser, and evaluates local relevance",
		() => {
			const url =
				"https://www.championnewspapers.com/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html";
			const meta = extractArticleMetadata(articleHtml, url);

			assert.equal(
				meta.title,
				"7-Eleven, gas station, car wash to replace Corner Bar area",
			);
			assert.ok(meta.body?.includes("Evergreen Devco"));
			assert.equal(meta.occurred_at, "2026-08-15T00:00:00-07:00");
			assert.equal(
				meta.external_id,
				"article_c053f101-5e05-4709-9c2c-2cd72cda7c5e",
			);
			assert.equal(meta.meta.outlet, "The Champion");
			assert.equal(meta.meta.section, "community_news");
			assert.equal(meta.meta.chinoRelevant, true);
		},
	);

	await t.test(
		"extractArticleMetadata marks non-Chino community news article as not locally relevant",
		() => {
			const url =
				"https://www.championnewspapers.com/community_news/article_5f197cf8-0a8e-4414-b9a0-1a7511c8e7f8.html";
			const meta = extractArticleMetadata(nonLocalHtml, url);

			assert.equal(meta.title, "Regional water agency holds annual symposium");
			assert.equal(meta.meta.chinoRelevant, false);
		},
	);
});

const SITEMAP_INDEX =
	"https://www.championnewspapers.com/tncms/sitemap/editorial.xml";
const LATEST_EDITION = `${SITEMAP_INDEX}?date=2026-08-15`;
const ARTICLE_A =
	"https://www.championnewspapers.com/community_news/article_c053f101-5e05-4709-9c2c-2cd72cda7c5e.html";
const ARTICLE_B =
	"https://www.championnewspapers.com/community_news/article_5f197cf8-0a8e-4414-b9a0-1a7511c8e7f8.html";

test("champion-news run orchestration", async (t) => {
	const editionSitemapXml = readFileSync(
		join(fixturesDir, "champion-edition-sitemap.xml"),
		"utf8",
	);
	const sitemapIndexXml = readFileSync(
		join(fixturesDir, "champion-sitemap.xml"),
		"utf8",
	);
	const articleHtml = readFileSync(
		join(fixturesDir, "champion-article.html"),
		"utf8",
	);
	const nonLocalHtml = readFileSync(
		join(fixturesDir, "champion-community-non-local.html"),
		"utf8",
	);

	await t.test(
		"ingests the newest edition, not the first one listed",
		async () => {
			const { ctx, items, requested } = fakeScraperContext({
				[SITEMAP_INDEX]: sitemapIndexXml,
				[LATEST_EDITION]: editionSitemapXml,
				[ARTICLE_A]: articleHtml,
				[ARTICLE_B]: nonLocalHtml,
			});

			await championNewsScraper.run(ctx);

			// The index lists 2026-08-08 first; the run must take 2026-08-15.
			assert.ok(requested.includes(LATEST_EDITION));
			assert.equal(items.length, 2);
			assert.equal(
				items[0].external_id,
				"article_c053f101-5e05-4709-9c2c-2cd72cda7c5e",
			);
		},
	);

	await t.test(
		"falls back to category indexes when the sitemap is unreachable",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				[SITEMAP_INDEX]: new Error("DNS failure"),
				"https://www.championnewspapers.com/news/": `<a href="${ARTICLE_A}">a</a>`,
				"https://www.championnewspapers.com/community_news/": `<a href="${ARTICLE_B}">b</a>`,
				[ARTICLE_A]: articleHtml,
				[ARTICLE_B]: nonLocalHtml,
			});

			await championNewsScraper.run(ctx);

			assert.ok(notes.some((n) => n.includes("Sitemap discovery failed")));
			assert.equal(items.length, 2);
		},
	);

	await t.test("one dead category index does not sink the other", async () => {
		const { ctx, items, notes } = fakeScraperContext({
			[SITEMAP_INDEX]: { status: 503 },
			"https://www.championnewspapers.com/news/": new Error("timed out"),
			"https://www.championnewspapers.com/community_news/": `<a href="${ARTICLE_A}">a</a>`,
			[ARTICLE_A]: articleHtml,
		});

		await championNewsScraper.run(ctx);

		assert.ok(notes.some((n) => n.includes("timed out")));
		assert.equal(items.length, 1);
	});

	await t.test(
		"ingests nothing, and complains, when discovery comes back empty",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				[SITEMAP_INDEX]: { status: 404 },
				"https://www.championnewspapers.com/news/": "<html>no links</html>",
				"https://www.championnewspapers.com/community_news/": "<html></html>",
			});

			await championNewsScraper.run(ctx);

			assert.equal(items.length, 0);
			assert.ok(notes.some((n) => n.includes("Discovered 0 candidate")));
		},
	);

	await t.test("caps a large edition at 15 articles per run", async () => {
		// A publisher dumping a full back catalogue into one sitemap must not turn
		// into an unbounded crawl of that outlet.
		const urls = Array.from(
			{ length: 20 },
			(_, i) =>
				`https://www.championnewspapers.com/news/article_${String(i).padStart(8, "0")}-0000-0000-0000-000000000000.html`,
		);
		const responses: Record<string, string> = {
			[SITEMAP_INDEX]: sitemapIndexXml,
			[LATEST_EDITION]: `<?xml version="1.0"?><urlset>${urls
				.map((u) => `<url><loc>${u}</loc></url>`)
				.join("")}</urlset>`,
		};
		for (const u of urls) responses[u] = articleHtml;

		const { ctx, items } = fakeScraperContext(responses);
		await championNewsScraper.run(ctx);

		assert.equal(items.length, 15);
	});
});
