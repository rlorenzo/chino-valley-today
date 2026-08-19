import assert from "node:assert/strict";
import test from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import chinoNewsRssScraper from "./chino-news-rss.ts";

// Only the Alert Center (ModID=63) ingestion is exercised here; every other
// endpoint run() touches is given an empty/no-op response so a run completes
// without reaching for a URL this test did not anticipate.

const BASE = "https://www.cityofchino.org";
const EMPTY_RSS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
const ALERT_URL = `${BASE}/RSSFeed.aspx?ModID=63&CID=All-0`;

function baseResponses(alertXml: string): Record<string, string | Error> {
	return {
		[`${BASE}/RSS.aspx`]: new Error("robots.txt disallow"),
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Chino-Spotlights-1`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Community-Services-Spotlights-7`]:
			EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Fact-Page-10`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Police-Spotlights-8`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Success-Stories-9`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=58&CID=Police-Department-26`]: EMPTY_RSS,
		[`${BASE}/597/News-Releases`]: "<html><body>no releases</body></html>",
		[`${BASE}/RSSFeed.aspx?ModID=58&CID=All-calendar.xml`]: EMPTY_RSS,
		[ALERT_URL]: alertXml,
	};
}

test("chino-news-rss Alert Center ingestion", async (t) => {
	await t.test(
		"an empty Alert Center feed inserts nothing and notes the empty-is-normal caveat",
		async () => {
			const { ctx, items, notes } = fakeScraperContext(
				baseResponses(EMPTY_RSS),
			);

			await chinoNewsRssScraper.run(ctx);

			assert.equal(items.filter((i) => i.item_type === "alert").length, 0);
			assert.ok(
				notes.some((n) =>
					n.includes("Empty is the normal state for Alert Center"),
				),
			);
		},
	);

	await t.test(
		"a populated Alert Center feed ingests items as item_type 'alert' with a stable external_id",
		async () => {
			const alertFeed = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Chino, CA - Alert Center</title>
    <lastBuildDate>Wed, 19 Aug 2026 12:00:00 GMT</lastBuildDate>
    <item>
      <title>Boil Water Notice — Central Ave Water Main Break</title>
      <link>https://www.cityofchino.org/CivicAlerts.aspx?AID=99</link>
      <pubDate>Wed, 19 Aug 2026 11:45:00 GMT</pubDate>
      <description>&lt;p&gt;Residents near Central Ave should boil tap water until further notice.&lt;/p&gt;</description>
      <guid isPermaLink="false">{ALERT-99}</guid>
    </item>
  </channel>
</rss>`;
			const { ctx, items } = fakeScraperContext(baseResponses(alertFeed));

			await chinoNewsRssScraper.run(ctx);

			const alerts = items.filter((i) => i.item_type === "alert");
			assert.equal(alerts.length, 1);
			assert.equal(alerts[0].external_id, "{ALERT-99}");
			assert.equal(
				alerts[0].source_url,
				"https://www.cityofchino.org/CivicAlerts.aspx?AID=99",
			);
			assert.equal(
				alerts[0].title,
				"Boil Water Notice — Central Ave Water Main Break",
			);
			assert.equal(
				alerts[0].body,
				"Residents near Central Ave should boil tap water until further notice.",
			);
		},
	);
});
