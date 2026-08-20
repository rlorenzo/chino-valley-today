import assert from "node:assert/strict";
import test from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import chinohillsNewsRssScraper from "./chinohills-news-rss.ts";

// Only the Alert Center (ModID=63) ingestion is exercised here; every other
// endpoint run() touches is given an empty/no-op response so a run completes
// without reaching for a URL this test did not anticipate.

const BASE = "https://www.chinohills.org";
const EMPTY_RSS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
const ALERT_URL = `${BASE}/RSSFeed.aspx?ModID=63&CID=All-0`;

function baseResponses(alertXml: string): Record<string, string | Error> {
	return {
		[`${BASE}/RSS.aspx`]: new Error("robots.txt disallow"),
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Local-News-1`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=2025-Home-Spotlight-12`]: EMPTY_RSS,
		[ALERT_URL]: alertXml,
	};
}

test("chinohills-news-rss Alert Center ingestion", async (t) => {
	await t.test(
		"an empty Alert Center feed inserts nothing and notes the empty-is-normal caveat",
		async () => {
			const { ctx, items, notes } = fakeScraperContext(
				baseResponses(EMPTY_RSS),
			);

			await chinohillsNewsRssScraper.run(ctx);

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
    <title>Chino Hills - Alert Center</title>
    <lastBuildDate>Wed, 19 Aug 2026 12:00:00 GMT</lastBuildDate>
    <item>
      <title>Evacuation Warning — Butterfield Ranch Area</title>
      <link>https://www.chinohills.org/CivicAlerts.aspx?AID=42</link>
      <pubDate>Wed, 19 Aug 2026 10:15:00 GMT</pubDate>
      <description>&lt;p&gt;An evacuation warning is in effect for the Butterfield Ranch area.&lt;/p&gt;</description>
      <guid isPermaLink="false">{ALERT-42}</guid>
    </item>
  </channel>
</rss>`;
			const { ctx, items } = fakeScraperContext(baseResponses(alertFeed));

			await chinohillsNewsRssScraper.run(ctx);

			const alerts = items.filter((i) => i.item_type === "alert");
			assert.equal(alerts.length, 1);
			assert.equal(alerts[0].external_id, "{ALERT-42}");
			assert.equal(
				alerts[0].source_url,
				"https://www.chinohills.org/CivicAlerts.aspx?AID=42",
			);
			assert.equal(
				alerts[0].title,
				"Evacuation Warning — Butterfield Ranch Area",
			);
			assert.equal(
				alerts[0].body,
				"An evacuation warning is in effect for the Butterfield Ranch area.",
			);
		},
	);
});
