import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import breezeNewsScraper from "./breeze-news.ts";
import bulldogtimesNewsScraper from "./bulldogtimes-news.ts";
import {
	extractTeaser,
	type FeedPressItem,
	parseFeedItems,
} from "./feed-press.ts";
import nbc4NewsScraper, { nbc4PubDateToIso } from "./nbc4-news.ts";
import questNewsScraper from "./quest-news.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "__fixtures__");

const QUEST_FEED_URL = "https://dalquestnews.org/feed/";
const BULLDOG_FEED_URL = "https://ayalabulldogtimes.org/feed/";
const BREEZE_FEED_URL = "https://thebreezepaper.com/feed/";
const NBC4_FEED_URL = "https://www.nbclosangeles.com/?rss=y&most_recent=y";

// A structurally valid but empty WordPress feed — the shape dalquestnews.org
// and ayalabulldogtimes.org actually serve when dormant between issues
// (verified 2026-08-19), not merely a blank string.
const EMPTY_WORDPRESS_FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">
<channel>
	<title>Quest News</title>
	<link>https://dalquestnews.org</link>
	<description>The Student News Site of Don Lugo High School</description>
</channel>
</rss>`;

test("feed-press core: parsing helpers", async (t) => {
	await t.test("parseFeedItems falls back to link when guid is absent", () => {
		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
				<item><title>No Guid</title><link>https://example.org/a/</link></item>
			</channel></rss>`;
		const [item] = parseFeedItems(xml);
		assert.equal(item.guid, "https://example.org/a/");
	});

	await t.test(
		"extractTeaser prefers description, falls back to content:encoded, sentence-bounds either",
		() => {
			const withDescription: FeedPressItem = {
				title: "t",
				link: "https://example.org/a/",
				guid: "https://example.org/a/",
				description:
					"First sentence here. Second sentence follows along nicely.",
			};
			assert.equal(
				extractTeaser(withDescription),
				"First sentence here. Second sentence follows along nicely.",
			);

			const emptyDescription: FeedPressItem = {
				title: "t",
				link: "https://example.org/b/",
				guid: "https://example.org/b/",
				description: "",
				contentEncoded: "<p>Only the encoded body has real text.</p>",
			};
			assert.equal(
				extractTeaser(emptyDescription),
				"Only the encoded body has real text.",
			);

			const neither: FeedPressItem = {
				title: "t",
				link: "https://example.org/c/",
				guid: "https://example.org/c/",
			};
			assert.equal(extractTeaser(neither), null);
		},
	);
});

test("quest-news run orchestration (shared feed-press core)", async (t) => {
	await t.test("populated feed ingests both items with city meta", async () => {
		const feedXml = readFileSync(join(fixturesDir, "quest-feed.xml"), "utf8");
		const { ctx, items, notes } = fakeScraperContext({
			[QUEST_FEED_URL]: feedXml,
		});

		await questNewsScraper.run(ctx);

		assert.equal(items.length, 2);
		assert.equal(
			items[0].title,
			"Don Lugo Drama Club Stages Spring One-Act Festival",
		);
		assert.equal(items[0].external_id, "https://dalquestnews.org/?p=4021");
		assert.equal(
			items[0].source_url,
			"https://dalquestnews.org/2026/04/16/drama-club-spring-one-act-festival/",
		);
		assert.equal(items[0].occurred_at, "2026-04-16T19:30:00.000Z");
		assert.deepEqual(items[0].meta, {
			outlet: "Quest News",
			feedUrl: QUEST_FEED_URL,
			city: "Chino",
		});
		assert.ok((items[0].body?.length ?? 0) <= 280);
		assert.equal((items[1].meta as { city: string }).city, "Chino");

		assert.ok(notes.some((n) => n.includes("2 feed item(s), 2 ingested")));
	});

	await t.test(
		"empty feed (dormant between issues) ingests nothing and says so",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				[QUEST_FEED_URL]: EMPTY_WORDPRESS_FEED,
			});

			await questNewsScraper.run(ctx);

			assert.equal(items.length, 0);
			assert.ok(
				notes.some(
					(n) =>
						n.includes("0 feed item(s), 0 ingested") &&
						n.includes("normal for this source"),
				),
				`expected a "0-item run is normal" note, got: ${notes.join(" | ")}`,
			);
		},
	);
});

test("bulldogtimes-news run orchestration (config wiring)", async (t) => {
	await t.test(
		"fetches its own feed URL and tags items with its own outlet and city",
		async () => {
			// Feed content is shape-identical across the WordPress papers, so the
			// quest fixture serves here; what this test pins is the wiring that
			// differs per module — feed URL, outlet label, city tag.
			const feedXml = readFileSync(join(fixturesDir, "quest-feed.xml"), "utf8");
			const { ctx, items, requested } = fakeScraperContext({
				[BULLDOG_FEED_URL]: feedXml,
			});

			await bulldogtimesNewsScraper.run(ctx);

			assert.deepEqual(requested, [BULLDOG_FEED_URL]);
			assert.equal(items.length, 2);
			assert.deepEqual(items[0].meta, {
				outlet: "Bulldog Times",
				feedUrl: BULLDOG_FEED_URL,
				city: "Chino Hills",
			});
		},
	);
});

test("breeze-news run orchestration (no fixed city tag)", async (t) => {
	await t.test(
		"ingests every item without a city tag; an embed-only magazine post gets no teaser",
		async () => {
			const feedXml = readFileSync(
				join(fixturesDir, "breeze-feed.xml"),
				"utf8",
			);
			const { ctx, items, notes } = fakeScraperContext({
				[BREEZE_FEED_URL]: feedXml,
			});

			await breezeNewsScraper.run(ctx);

			assert.equal(items.length, 3);
			// No fixed city tag: The Breeze's coverage area is not itself local,
			// so relevance is left to daily-brief's text-matched geo-alias path.
			assert.deepEqual(items[0].meta, {
				outlet: "The Breeze",
				feedUrl: BREEZE_FEED_URL,
			});

			// The magazine post's <description> is empty and its <content:encoded>
			// is only a fliphtml5 <iframe> embed — no extractable sentence, so no
			// teaser, but the item itself still ingests as a title + link.
			const magazine = items.find(
				(i) => i.title === "The Breeze Magazine Spring 2026",
			);
			assert.ok(magazine, "expected the magazine embed item to ingest");
			assert.equal(magazine.body, null);

			// A regular article's teaser comes from <description> as usual.
			const juneteenth = items.find(
				(i) =>
					i.title === "Chaffey College Hosts Annual Juneteenth Celebration",
			);
			assert.ok(juneteenth, "expected the Juneteenth article to ingest");
			assert.equal(
				juneteenth.body,
				"Thursday, June 18, 2026, Chaffey College hosted a celebration in honor of Juneteenth.",
			);

			assert.ok(notes.some((n) => n.includes("3 feed item(s), 3 ingested")));
		},
	);
});

test("nbc4-news run orchestration (Chino keyword filter)", async (t) => {
	await t.test(
		"only the Chino-matching item of a mixed feed is ingested",
		async () => {
			const feedXml = readFileSync(join(fixturesDir, "nbc4-feed.xml"), "utf8");
			const { ctx, items, notes } = fakeScraperContext({
				[NBC4_FEED_URL]: feedXml,
			});

			await nbc4NewsScraper.run(ctx);

			// Fixture has 3 items: an LAPD chase and an art-walk story with no
			// Chino mention, plus one synthesized Chino Hills council story.
			assert.equal(items.length, 1);
			assert.equal(
				items[0].title,
				"Chino Hills council reviews Peyton Drive repaving project timeline",
			);
			assert.equal(
				(items[0].meta as { chinoKeyword: string }).chinoKeyword,
				"Chino Hills",
			);

			assert.ok(notes.some((n) => n.includes("3 feed item(s), 1 ingested")));
			assert.ok(notes.some((n) => n.includes("2 filtered out")));
		},
	);

	await t.test(
		"the stored teaser is sentence-bounded and never the full feed body",
		async () => {
			const feedXml = readFileSync(join(fixturesDir, "nbc4-feed.xml"), "utf8");
			const { ctx, items } = fakeScraperContext({ [NBC4_FEED_URL]: feedXml });

			await nbc4NewsScraper.run(ctx);

			const [item] = items;
			assert.ok(item.body, "expected a teaser body");
			assert.ok(
				(item.body as string).length <= 280,
				`teaser was ${(item.body as string).length} chars, expected <= 280`,
			);
			// The full NBC4 <description> for this fixture item runs to three
			// paragraphs; the stored teaser must stop well short of that, at a
			// sentence boundary, never the raw feed body.
			assert.ok(
				!(item.body as string).includes("staff said"),
				"teaser leaked the article's closing sentence — full body was stored",
			);
		},
	);

	await t.test(
		"NBC4's offset-less pubDate is parsed as Pacific local time, not the host's own timezone",
		() => {
			// Verified live 2026-08-19: NBC4's feed carries no UTC offset
			// ("Wed, Aug 19 2026 06:13:12 PM"), unlike the WordPress feeds'
			// standard RFC 2822 timestamps. A bare `new Date()` parse of that
			// string resolves against the running process's own timezone, which
			// is only correct by accident on a host already set to Pacific.
			assert.equal(
				nbc4PubDateToIso("Wed, Aug 19 2026 06:13:12 PM"),
				"2026-08-20T01:13:12.000Z",
			);
			// A standard RFC 2822 timestamp (offset present) still parses
			// correctly through the same function, in case the feed format
			// reverts.
			assert.equal(
				nbc4PubDateToIso("Wed, 19 Aug 2026 18:30:50 -0700"),
				"2026-08-20T01:30:50.000Z",
			);
			assert.equal(nbc4PubDateToIso(undefined), null);
			assert.equal(nbc4PubDateToIso("not a date"), null);
		},
	);
});
