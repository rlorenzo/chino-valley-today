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
const CALENDAR_URL = `${BASE}/RSSFeed.aspx?ModID=58&CID=Community-Calendar-14`;

function baseResponses(
	alertXml: string,
	calendarXml = EMPTY_RSS,
): Record<string, string | Error> {
	return {
		[`${BASE}/RSS.aspx`]: new Error("robots.txt disallow"),
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=Local-News-1`]: EMPTY_RSS,
		[`${BASE}/RSSFeed.aspx?ModID=1&CID=2025-Home-Spotlight-12`]: EMPTY_RSS,
		[ALERT_URL]: alertXml,
		[CALENDAR_URL]: calendarXml,
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

test("chinohills-news-rss Community Calendar ingestion", async () => {
	const calendarFeed = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:calendarEvent="https://www.chinohills.org/Calendar.aspx">
  <channel>
    <title>Chino Hills - Calendar - Community Calendar</title>
    <item>
      <title>Pop-Up City Hall</title>
      <link>https://www.chinohills.org/Calendar.aspx?EID=5012</link>
      <description>&lt;strong&gt;Event date:&lt;/strong&gt; October 3, 2026 &lt;br&gt;&lt;strong&gt;Event Time: &lt;/strong&gt;10:00 AM - 01:00 PM</description>
      <guid isPermaLink="false">Calendar.aspx?EID=5012</guid>
      <calendarEvent:EventDates> October 3, 2026 </calendarEvent:EventDates>
      <calendarEvent:EventTimes>10:00 AM - 01:00 PM</calendarEvent:EventTimes>
      <calendarEvent:Location>Chino Hills Community Center</calendarEvent:Location>
    </item>
  </channel>
</rss>`;
	const { ctx, items } = fakeScraperContext(
		baseResponses(EMPTY_RSS, calendarFeed),
	);

	await chinohillsNewsRssScraper.run(ctx);

	const events = items.filter((i) => i.item_type === "event");
	assert.equal(events.length, 1);
	assert.equal(events[0].title, "Pop-Up City Hall");
	assert.equal(
		events[0].source_url,
		"https://www.chinohills.org/Calendar.aspx?EID=5012",
	);
	// 10:00 AM Pacific (PDT) on October 3.
	assert.equal(events[0].occurred_at, "2026-10-03T17:00:00.000Z");
});
