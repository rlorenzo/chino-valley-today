import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import dailyBulletinNewsScraper, {
	extractDailyBulletinMetadata,
	parseLocationHub,
} from "./dailybulletin-news.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "__fixtures__");

test("dailybulletin-news scraper parsing & extraction", async (t) => {
	const hubHtml = readFileSync(
		join(fixturesDir, "dailybulletin-chino.html"),
		"utf8",
	);
	const articleHtml = readFileSync(
		join(fixturesDir, "dailybulletin-article.html"),
		"utf8",
	);

	await t.test("parseLocationHub extracts article URLs", () => {
		const urls = parseLocationHub(hubHtml);
		assert.equal(urls.length, 2);
		assert.equal(
			urls[0],
			"https://www.dailybulletin.com/2026/08/16/chino-valleys-sonja-shaw-rides-anger-over-covid-rules-to-bid-for-state-superintendent/",
		);
	});

	await t.test(
		"extractDailyBulletinMetadata extracts title, truncated teaser, and evaluates local relevance",
		() => {
			const url =
				"https://www.dailybulletin.com/2026/08/16/chino-valleys-sonja-shaw-rides-anger-over-covid-rules-to-bid-for-state-superintendent/";
			const meta = extractDailyBulletinMetadata(articleHtml, url, "Chino");

			assert.equal(
				meta.title,
				"Chino Valley's Sonja Shaw rides anger over COVID rules to bid for state superintendent",
			);
			assert.ok(meta.body?.includes("Chino Valley school board"));
			assert.equal(meta.occurred_at, "2026-08-16T15:00:00+00:00");
			assert.equal(
				meta.external_id,
				"2026/08/16/chino-valleys-sonja-shaw-rides-anger-over-covid-rules-to-bid-for-state-superintendent",
			);
			assert.equal(meta.meta.outlet, "Daily Bulletin");
			assert.equal(meta.meta.city, "Chino");
			assert.equal(meta.meta.chinoRelevant, true);
		},
	);
});

const CHINO_HUB =
	"https://www.dailybulletin.com/location/california/san-bernardino-county/chino/";
const CHINO_HILLS_HUB =
	"https://www.dailybulletin.com/location/california/san-bernardino-county/chino-hills/";
const SHARED_ARTICLE =
	"https://www.dailybulletin.com/2026/08/16/chino-valleys-sonja-shaw-rides-anger-over-covid-rules-to-bid-for-state-superintendent/";
const HILLS_ONLY_ARTICLE =
	"https://www.dailybulletin.com/2026/08/17/chino-hills-council-approves-carbon-canyon-repaving/";

test("dailybulletin-news run orchestration", async (t) => {
	const articleHtml = readFileSync(
		join(fixturesDir, "dailybulletin-article.html"),
		"utf8",
	);
	const hubHtml = readFileSync(
		join(fixturesDir, "dailybulletin-chino.html"),
		"utf8",
	);

	await t.test(
		"an article listed by both hubs is ingested once, tagged by the first",
		async () => {
			const { ctx, items } = fakeScraperContext({
				[CHINO_HUB]: `<a href="${SHARED_ARTICLE}">shared</a>`,
				[CHINO_HILLS_HUB]: `<a href="${SHARED_ARTICLE}">shared</a><a href="${HILLS_ONLY_ARTICLE}">hills</a>`,
				[SHARED_ARTICLE]: articleHtml,
				[HILLS_ONLY_ARTICLE]: articleHtml,
			});

			await dailyBulletinNewsScraper.run(ctx);

			assert.equal(items.length, 2);
			assert.deepEqual(
				items.map((i) => (i.meta as { city: string }).city),
				["Chino", "Chino Hills"],
			);
		},
	);

	await t.test(
		"a dead hub does not take the other hub down with it",
		async () => {
			const { ctx, items, notes } = fakeScraperContext({
				[CHINO_HUB]: new Error("connection refused"),
				[CHINO_HILLS_HUB]: `<a href="${HILLS_ONLY_ARTICLE}">hills</a>`,
				[HILLS_ONLY_ARTICLE]: articleHtml,
			});

			await dailyBulletinNewsScraper.run(ctx);

			assert.ok(notes.some((n) => n.includes("connection refused")));
			assert.equal(items.length, 1);
			assert.equal((items[0].meta as { city: string }).city, "Chino Hills");
		},
	);

	await t.test(
		"fetches no articles when both hubs come back empty",
		async () => {
			const { ctx, items, requested } = fakeScraperContext({
				[CHINO_HUB]: { status: 404 },
				[CHINO_HILLS_HUB]: "<html>no articles yet</html>",
			});

			await dailyBulletinNewsScraper.run(ctx);

			assert.equal(items.length, 0);
			assert.deepEqual(requested, [CHINO_HUB, CHINO_HILLS_HUB]);
		},
	);

	await t.test("caps a busy news day at 15 articles per run", async () => {
		const urls = Array.from(
			{ length: 18 },
			(_, i) =>
				`https://www.dailybulletin.com/2026/08/17/chino-story-number-${i}/`,
		);
		const responses: Record<string, string> = {
			[CHINO_HUB]: urls.map((u) => `<a href="${u}">x</a>`).join(""),
			[CHINO_HILLS_HUB]: hubHtml,
		};
		for (const u of urls) responses[u] = articleHtml;

		const { ctx, items } = fakeScraperContext(responses);
		await dailyBulletinNewsScraper.run(ctx);

		assert.equal(items.length, 15);
	});
});
