import assert from "node:assert/strict";
import test from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import {
	type ArticleCandidate,
	collectArticleLinks,
	ingestArticles,
	type PressArticle,
	parseArticleHead,
} from "./press-article.ts";

const SUFFIX = /\s*\|\s*The Example.*$/i;

test("parseArticleHead", async (t) => {
	await t.test("prefers Open Graph tags and strips the outlet suffix", () => {
		const head = parseArticleHead(
			`<html><head>
				<title>Ignored headline | The Example</title>
				<meta property="og:title" content="Council approves plan | The Example">
				<meta property="og:description" content="First sentence. Second sentence.">
				<meta name="description" content="Ignored fallback.">
				<meta property="article:published_time" content="2026-08-15T09:00:00-07:00">
			 </head><body></body></html>`,
			SUFFIX,
		);

		assert.equal(head.title, "Council approves plan");
		assert.equal(head.teaser, "First sentence. Second sentence.");
		assert.equal(head.occurredAt, "2026-08-15T09:00:00-07:00");
	});

	await t.test("falls back to h1.entry-title, then <title>", () => {
		const fromH1 = parseArticleHead(
			`<html><head><title>Wrong | The Example</title></head>
			 <body><h1 class="entry-title">Right headline</h1></body></html>`,
			SUFFIX,
		);
		assert.equal(fromH1.title, "Right headline");

		const fromTitle = parseArticleHead(
			"<html><head><title>Only headline | The Example</title></head></html>",
			SUFFIX,
		);
		assert.equal(fromTitle.title, "Only headline");
	});

	await t.test("falls back to name=description and to <time datetime>", () => {
		const head = parseArticleHead(
			`<html><head>
				<meta property="og:title" content="Headline">
				<meta name="description" content="Fallback teaser sentence.">
			 </head><body><time datetime="2026-08-16T12:00:00Z">Aug 16</time></body></html>`,
			SUFFIX,
		);
		assert.equal(head.teaser, "Fallback teaser sentence.");
		assert.equal(head.occurredAt, "2026-08-16T12:00:00Z");
	});

	await t.test("decodes entities and truncates to whole sentences", () => {
		const long = `${"Alpha bravo charlie delta echo foxtrot golf hotel india juliet. ".repeat(4)}Tail sentence.`;
		const head = parseArticleHead(
			`<html><head>
				<meta property="og:title" content="7-Eleven &amp; friends">
				<meta property="og:description" content="${long}">
			 </head></html>`,
			SUFFIX,
		);

		assert.equal(head.title, "7-Eleven & friends");
		assert.ok(head.teaser);
		assert.ok((head.teaser?.length ?? 0) <= 280);
		// Never cuts mid-sentence.
		assert.ok(head.teaser?.endsWith("."));
		assert.ok(!head.teaser?.includes("Tail sentence"));
	});

	await t.test("reports a missing headline as null rather than empty", () => {
		const head = parseArticleHead(
			"<html><head></head><body></body></html>",
			SUFFIX,
		);
		assert.equal(head.title, null);
		assert.equal(head.teaser, null);
		assert.equal(head.occurredAt, null);
	});
});

test("collectArticleLinks", async (t) => {
	const isArticle = (pathname: string) => /^\/news\/[a-z0-9-]+$/.test(pathname);

	await t.test("resolves relative hrefs and drops query strings", () => {
		const urls = collectArticleLinks(
			`<a href="/news/one">1</a>
			 <a href="https://www.site.example/news/two?utm_source=rss">2</a>`,
			"https://www.site.example",
			isArticle,
		);
		assert.deepEqual(urls, [
			"https://www.site.example/news/one",
			"https://www.site.example/news/two",
		]);
	});

	await t.test("drops off-site, insecure and non-article links", () => {
		const urls = collectArticleLinks(
			`<a href="https://elsewhere.example/news/off-site">off</a>
			 <a href="http://www.site.example/news/insecure">insecure</a>
			 <a href="/about">not an article</a>
			 <a href="mailto:tips@site.example">mail</a>
			 <a href="/news/keeper">keep</a>`,
			"https://www.site.example",
			isArticle,
		);
		assert.deepEqual(urls, ["https://www.site.example/news/keeper"]);
	});

	await t.test(
		"collapses bare and www spellings of the same article onto the base origin",
		() => {
			// Both spellings reach the same story. Keeping them apart would fetch it
			// twice and store two items, since item identity is keyed on the
			// document URL.
			const urls = collectArticleLinks(
				`<a href="https://site.example/news/one">a</a>
			 <a href="https://www.site.example/news/one">b</a>`,
				"https://www.site.example",
				isArticle,
			);
			assert.deepEqual(urls, ["https://www.site.example/news/one"]);
		},
	);
});

test("ingestArticles", async (t) => {
	// These fixtures use bare slugs, not a real outlet's permalink shape; the
	// path check is exercised on its own below.
	const anyPath = (): boolean => true;

	const article = (
		html: string,
		url: string,
		candidate: ArticleCandidate,
	): PressArticle => ({
		external_id: new URL(url).pathname,
		title: html.includes("untitled") ? null : `Title for ${url}`,
		body: "Teaser.",
		occurred_at: "2026-08-16T15:00:00Z",
		meta: { city: candidate.city },
	});

	await t.test(
		"inserts one item per candidate, tagged as a news article",
		async () => {
			const { ctx, items } = fakeScraperContext({
				"https://site.example/a": "<html>a</html>",
				"https://site.example/b": "<html>b</html>",
			});

			await ingestArticles(
				ctx,
				[
					{ url: "https://site.example/a", city: "Chino" },
					{ url: "https://site.example/b", city: "Chino Hills" },
				],
				article,
				anyPath,
			);

			assert.equal(items.length, 2);
			assert.deepEqual(
				items.map((i) => i.source_url),
				["https://site.example/a", "https://site.example/b"],
			);
			assert.ok(items.every((i) => i.item_type === "news_article"));
			// The candidate's own city reaches the extractor, not just the URL.
			assert.deepEqual(
				items.map((i) => (i.meta as { city?: string }).city),
				["Chino", "Chino Hills"],
			);
			// Each item is linked to the document it was extracted from.
			assert.equal(new Set(items.map((i) => i.document_id)).size, 2);
		},
	);

	await t.test(
		"a failing article never costs the run the ones behind it",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				"https://site.example/broken": new Error("connection reset"),
				"https://site.example/gone": { status: 404 },
				"https://site.example/good": "<html>good</html>",
			});

			await ingestArticles(
				ctx,
				[
					{ url: "https://site.example/broken" },
					{ url: "https://site.example/gone" },
					{ url: "https://site.example/good" },
				],
				article,
				anyPath,
			);

			assert.equal(items.length, 1);
			assert.equal(items[0].source_url, "https://site.example/good");
			assert.ok(notes.some((n) => n.includes("connection reset")));
			assert.ok(notes.some((n) => n.includes("HTTP 404")));
		},
	);

	await t.test(
		"skips an article the outlet gave no headline, and notes it",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				"https://site.example/untitled": "<html>untitled</html>",
			});

			await ingestArticles(
				ctx,
				[{ url: "https://site.example/untitled" }],
				article,
				anyPath,
			);

			assert.equal(items.length, 0);
			assert.ok(notes.some((n) => n.includes("without title")));
		},
	);

	await t.test(
		"stores the redirect target, not the URL we started from",
		async () => {
			// The candidate URL came off a listing page; the canonical URL is wherever
			// the outlet redirected us. Storing the pre-redirect URL would publish a
			// link that bounces, and key the item on an id the outlet does not use.
			const { ctx, items } = fakeScraperContext({
				"https://site.example/old-slug": {
					status: 200,
					body: "<html>moved</html>",
					finalUrl: "https://site.example/new-slug",
				},
			});

			await ingestArticles(
				ctx,
				[{ url: "https://site.example/old-slug" }],
				article,
				anyPath,
			);

			assert.equal(items[0].source_url, "https://site.example/new-slug");
			assert.equal(items[0].external_id, "/new-slug");
		},
	);

	await t.test(
		"drops a redirect that lands somewhere the outlet does not publish articles",
		async () => {
			// dailybulletin.com carries stub permalinks matching the article path
			// shape whose only job is to 301 onto a tag archive. Ingested, the
			// archive becomes an "article" with a tag name for a headline, no
			// teaser, and the timestamp of whatever it last listed — so it reads
			// as fresh every morning and never ages out of the brief.
			const { ctx, items, notes } = fakeScraperContext({
				"https://site.example/2025/03/01/high-school-football-redirect/": {
					status: 200,
					body: "<html>tag archive</html>",
					finalUrl: "https://site.example/tag/high-school-football/",
				},
				"https://site.example/2026/08/20/a-real-story/": "<html>real</html>",
			});

			await ingestArticles(
				ctx,
				[
					{
						url: "https://site.example/2025/03/01/high-school-football-redirect/",
					},
					{ url: "https://site.example/2026/08/20/a-real-story/" },
				],
				article,
				(pathname) => /^\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\/?$/.test(pathname),
			);

			assert.deepEqual(
				items.map((i) => i.source_url),
				["https://site.example/2026/08/20/a-real-story/"],
			);
			assert.ok(
				notes.some(
					(n) =>
						n.includes("redirected to a non-article page") &&
						n.includes("/tag/high-school-football/"),
				),
			);
		},
	);

	await t.test(
		"drops a candidate whose own path is not an article",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				"https://site.example/tag/sports/": "<html>tag</html>",
			});

			await ingestArticles(
				ctx,
				[{ url: "https://site.example/tag/sports/" }],
				article,
				(pathname) => pathname.startsWith("/news/"),
			);

			assert.equal(items.length, 0);
			assert.ok(notes.some((n) => n.includes("Skipping non-article URL")));
		},
	);
});
