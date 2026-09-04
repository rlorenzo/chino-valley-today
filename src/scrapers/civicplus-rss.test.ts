import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	laDateOffset,
	localDateTimeToIso,
	parseRssItems,
	rfc2822ToIso,
	stripHtml,
	toArray,
} from "./civicplus-rss.ts";

// These helpers were duplicated verbatim in both CivicPlus scrapers and had no
// tests in either. They are now shared, so a regression here would hit both
// cities at once — which is exactly why they are worth pinning.

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:calendarEvent="http://example.gov/cal">
  <channel>
    <title>City News</title>
    <lastBuildDate>Fri, 14 Aug 2026 18:00:00 GMT</lastBuildDate>
    <item>
      <title>  Council approves budget  </title>
      <link>  https://example.gov/news/1  </link>
      <pubDate>Wed, 12 Aug 2026 17:30:00 GMT</pubDate>
      <description>&lt;p&gt;The council   voted &lt;b&gt;5-0&lt;/b&gt;.&lt;/p&gt;</description>
      <guid>https://example.gov/news/1/638288244670000000</guid>
    </item>
    <item>
      <title>Park closure</title>
      <link>https://example.gov/news/2</link>
      <guid isPermaLink="false">NR26-050</guid>
      <calendarEvent:Location>City Hall</calendarEvent:Location>
      <calendarEvent:EventDates>August 18, 2026</calendarEvent:EventDates>
    </item>
  </channel>
</rss>`;

describe("parseRssItems", () => {
	test("parses items, trimming title and link", () => {
		const items = parseRssItems(FEED);
		assert.equal(items.length, 2);
		assert.equal(items[0].title, "Council approves budget");
		assert.equal(items[0].link, "https://example.gov/news/1");
	});

	test("reads guid from either a bare value or an attributed element", () => {
		const items = parseRssItems(FEED);
		// Plain text node
		assert.equal(
			items[0].guid,
			"https://example.gov/news/1/638288244670000000",
		);
		// <guid isPermaLink="false">: value lives in #text once attributes are parsed
		assert.equal(items[1].guid, "NR26-050");
	});

	test("flattens calendarEvent: namespaced children into extra", () => {
		const items = parseRssItems(FEED);
		assert.deepEqual(items[1].extra, {
			Location: "City Hall",
			EventDates: "August 18, 2026",
		});
	});

	test("an item without namespaced children gets an empty extra, not undefined", () => {
		// Chino Hills' feed has none; downstream code indexes into extra directly.
		assert.deepEqual(parseRssItems(FEED)[0].extra, {});
	});

	test("a single <item> is still returned as an array", () => {
		// The XML parser collapses a lone repeated element to a scalar; toArray is
		// what keeps a one-item feed from being silently dropped.
		const one = FEED.replace(
			/<item>\s*<title>Park closure[\s\S]*?<\/item>/,
			"",
		);
		assert.equal(parseRssItems(one).length, 1);
	});

	test("a feed with no channel returns empty rather than throwing", () => {
		assert.deepEqual(parseRssItems("<rss></rss>"), []);
		assert.deepEqual(parseRssItems("<html>not a feed</html>"), []);
	});
});

describe("stripHtml", () => {
	test("removes markup and collapses whitespace", () => {
		assert.equal(
			stripHtml("<p>The council   voted <b>5-0</b>.</p>"),
			"The council voted 5-0.",
		);
	});

	test("decodes entities via the HTML parser", () => {
		assert.equal(
			stripHtml("Fish &amp; Game &lt;draft&gt;"),
			"Fish & Game <draft>",
		);
	});

	test("empty, null, and undefined all yield empty string", () => {
		assert.equal(stripHtml(""), "");
		assert.equal(stripHtml(null), "");
		assert.equal(stripHtml(undefined), "");
	});
});

describe("rfc2822ToIso", () => {
	test("converts an RSS pubDate to an ISO instant", () => {
		assert.equal(
			rfc2822ToIso("Wed, 12 Aug 2026 17:30:00 GMT"),
			"2026-08-12T17:30:00.000Z",
		);
	});

	test("returns null for missing or unparseable input rather than an Invalid Date", () => {
		assert.equal(rfc2822ToIso(undefined), null);
		assert.equal(rfc2822ToIso("not a date"), null);
	});
});

describe("toArray", () => {
	test("wraps a scalar, passes an array through, and maps nullish to empty", () => {
		assert.deepEqual(toArray("a"), ["a"]);
		assert.deepEqual(toArray(["a", "b"]), ["a", "b"]);
		assert.deepEqual(toArray(null), []);
		assert.deepEqual(toArray(undefined), []);
	});
});

describe("localDateTimeToIso", () => {
	test("converts a Pacific summer datetime (PDT, UTC-7)", () => {
		assert.equal(
			localDateTimeToIso("August 18, 2026", "06:00 PM"),
			"2026-08-19T01:00:00.000Z",
		);
	});

	test("converts a Pacific winter datetime (PST, UTC-8)", () => {
		assert.equal(
			localDateTimeToIso("January 5, 2026", "06:00 PM"),
			"2026-01-06T02:00:00.000Z",
		);
	});

	test("a date without a time is local midnight", () => {
		assert.equal(
			localDateTimeToIso("August 18, 2026"),
			"2026-08-18T07:00:00.000Z",
		);
	});

	test("returns null on an unrecognized date rather than guessing", () => {
		assert.equal(localDateTimeToIso("18 August 2026"), null);
		assert.equal(localDateTimeToIso("Notamonth 5, 2026"), null);
	});
});

describe("laDateOffset", () => {
	test("returns the LA-local date shifted by whole days, as YYYY-MM-DD", () => {
		// 2026-08-17T05:00:00Z is 2026-08-16 22:00 PDT; one day back -> 08-15.
		assert.equal(
			laDateOffset(new Date("2026-08-17T05:00:00Z"), -1),
			"2026-08-15",
		);
		// Same instant, no shift -> the LA date itself, not the UTC date.
		assert.equal(
			laDateOffset(new Date("2026-08-17T05:00:00Z"), 0),
			"2026-08-16",
		);
		// Forward, and across a year boundary (the CVUSD lookahead window).
		assert.equal(
			laDateOffset(new Date("2026-09-04T18:00:00Z"), 120),
			"2027-01-02",
		);
	});

	test("calendar-day arithmetic survives DST transitions near midnight", () => {
		// 2026-03-10T07:30:00Z is Mar 10 00:30 PDT, two days after the spring-
		// forward. Fixed-86400s subtraction landed on Mar 7; two calendar days
		// back is Mar 8.
		assert.equal(
			laDateOffset(new Date("2026-03-10T07:30:00Z"), -2),
			"2026-03-08",
		);
		// 2026-11-02T07:30:00Z is Nov 1 23:30 PST, late on the fall-back day.
		// Fixed-86400s subtraction stayed on Nov 1 (a zero-day lookback).
		assert.equal(
			laDateOffset(new Date("2026-11-02T07:30:00Z"), -1),
			"2026-10-31",
		);
	});
});
