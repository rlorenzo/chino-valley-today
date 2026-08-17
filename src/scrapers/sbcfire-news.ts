// Phase 4 Task 4.1 — San Bernardino County Fire news (press releases, major
// incidents). Standard WordPress RSS at sbcfire.org/feed/, verified 2026-08-17:
// valid RSS 2.0 with stable item-level permalinks (e.g.
// /news-headlines-07-21-2026/). County-wide content; Chino Valley relevance is
// flagged in meta rather than filtered at ingest — a regional major-incident
// release can matter to Chino readers without naming the city, and the daily
// brief assembler decides inclusion downstream.
//
// WordPress feeds carry full article HTML in <content:encoded> alongside the
// <description> teaser; parseRssItems() only surfaces description, so this
// scraper reads content:encoded itself from the parsed XML for full bodies.
import {
	parseRssItems,
	rfc2822ToIso,
	stripHtml,
	toArray,
	xmlParser,
} from "./civicplus-rss.ts";
import { resolveDocumentId } from "./document-linkage.ts";
import type { ScraperDef } from "./types.ts";

const FEED_URL = "https://sbcfire.org/feed/";
const CHINO_RE = /chino( hills)?/i;

// content:encoded full text per item guid, read from the raw parsed XML since
// FeedItem does not carry namespaced children outside calendarEvent:*.
export function contentEncodedByGuid(xml: string): Map<string, string> {
	const out = new Map<string, string>();
	const parsed = xmlParser.parse(xml) as Record<string, unknown>;
	const channel = (parsed?.rss as Record<string, unknown> | undefined)
		?.channel as Record<string, unknown> | undefined;
	for (const it of toArray(
		channel?.item as Record<string, unknown> | Record<string, unknown>[] | null,
	)) {
		const guidField = it.guid as { "#text"?: string } | string | undefined;
		const guid =
			(typeof guidField === "object" ? guidField?.["#text"] : guidField) ??
			String(it.link ?? "");
		const encoded = it["content:encoded"];
		if (typeof encoded === "string" && encoded.trim())
			out.set(guid, stripHtml(encoded));
	}
	return out;
}

const scraper: ScraperDef = {
	key: "sbcfire-news",
	name: "San Bernardino County Fire News",
	baseUrl: "https://sbcfire.org",
	method: "rss",
	async run(ctx) {
		const doc = await ctx.fetchDocument(FEED_URL, {
			docType: "feed",
			title: "SB County Fire news feed",
		});
		const xml = doc.body.toString("utf8");
		const items = parseRssItems(xml);
		const fullText = contentEncodedByGuid(xml);
		let chinoRelevant = 0;
		for (const it of items) {
			if (!it.link) continue;
			const body = fullText.get(it.guid) ?? (stripHtml(it.description) || null);
			const relevant = CHINO_RE.test(`${it.title} ${body ?? ""}`);
			if (relevant) chinoRelevant++;
			ctx.insertItem({
				document_id: resolveDocumentId(
					ctx,
					doc.documentId,
					it.guid,
					"news_release",
				),
				source_url: it.link,
				item_type: "news_release",
				external_id: it.guid,
				title: it.title,
				body,
				occurred_at: rfc2822ToIso(it.pubDate),
				meta: {
					feedUrl: FEED_URL,
					chinoRelevant: relevant,
					bodyIsFullText: fullText.has(it.guid),
				},
			});
		}
		ctx.note(
			`${items.length} item(s) in the feed; ${chinoRelevant} mention Chino/Chino Hills ` +
				`(county-wide source — relevance is flagged in meta, not filtered at ingest). ` +
				`${fullText.size} of ${items.length} carried full text via content:encoded.`,
		);
	},
};

export default scraper;
