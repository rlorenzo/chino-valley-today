// Shared plumbing for the two CivicPlus RSS scrapers (chino-news-rss.ts and
// chinohills-news-rss.ts). Both cities run the same CivicPlus product, so both
// scrapers had byte-identical copies of everything here — 181 duplicated lines
// across 6 clone groups before this module existed.
//
// Only genuinely city-agnostic code belongs here. Anything that encodes one
// city's feed layout, category ids, or relevance rules stays in that city's
// scraper.
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type { ScraperContext } from "./types.ts";

export const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	htmlEntities: true,
});

export function toArray<T>(v: T | T[] | undefined | null): T[] {
	if (v == null) return [];
	return Array.isArray(v) ? v : [v];
}

// RSS <description> carries escaped HTML; this recovers the plain teaser text.
export function stripHtml(input: string | undefined | null): string {
	if (!input) return "";
	return cheerio
		.load(`<div>${input}</div>`)("div")
		.text()
		.replace(/\s+/g, " ")
		.trim();
}

export function rfc2822ToIso(pubDate: string | undefined): string | null {
	if (!pubDate) return null;
	const d = new Date(pubDate);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// CivicPlus RSSFeed.aspx responses embed a live <lastBuildDate> timestamp, so
// re-fetching the *same* feed a moment later never hash-matches the prior
// document — every run gets a fresh documents row for feed URLs. Naively using
// that fresh document_id would make every feed-sourced item look "new" on every
// run. Fix: look up whether an item with this external_id already exists (from
// ANY earlier document under this source) and, if so, reuse ITS document_id so
// insertItem updates in place instead of inserting a duplicate row. Each run's
// feed fetch is still archived as its own real document (accurately reflecting
// that the resource changed) — only the item's document linkage is pinned to
// where it was first captured.
//
// NOTE: insertItem now resolves item identity as (document url, item_type,
// external_id), which covers this case centrally — a feed re-fetch is the same
// url with new bytes, so it already matches. This helper is therefore redundant
// and kept only to preserve today's exact linkage behaviour (items stay pinned
// to the FIRST document rather than being repointed to the newest). Removing it
// is tracked separately; doing it inside a de-duplication refactor would mix a
// behaviour change into a pure extraction.
export function resolveDocumentId(
	ctx: ScraperContext,
	freshDocumentId: number,
	externalId: string,
	itemType: string,
): number {
	const row = ctx.db.raw
		.prepare(
			`SELECT i.document_id AS documentId FROM items i
       JOIN documents d ON i.document_id = d.id
       WHERE i.external_id = ? AND i.item_type = ? AND d.source_id = ?
       ORDER BY i.id DESC LIMIT 1`,
		)
		.get(externalId, itemType, ctx.sourceId) as
		| { documentId: number }
		| undefined;
	return row?.documentId ?? freshDocumentId;
}

export interface FeedItem {
	title: string;
	link: string;
	pubDate?: string;
	description?: string;
	guid: string;
	// Namespaced <calendarEvent:*> children, flattened with the prefix stripped.
	// Chino's Calendar feed uses these; Chino Hills' news feed has none, so this
	// is simply an empty object there.
	extra: Record<string, string>;
}

export function parseRssItems(xml: string): FeedItem[] {
	const parsed = xmlParser.parse(xml) as Record<string, unknown>;
	const rss = parsed?.rss as Record<string, unknown> | undefined;
	const channel = rss?.channel as Record<string, unknown> | undefined;
	if (!channel) return [];
	const items = toArray(
		channel.item as
			| Record<string, unknown>
			| Record<string, unknown>[]
			| undefined,
	);
	return items.map((it) => {
		const guidField = it.guid as { "#text"?: string } | string | undefined;
		const guid =
			(typeof guidField === "object" ? guidField?.["#text"] : guidField) ??
			String(it.link ?? "");
		const extra: Record<string, string> = {};
		for (const k of Object.keys(it)) {
			if (k.startsWith("calendarEvent:"))
				extra[k.slice("calendarEvent:".length)] = String(it[k]);
		}
		return {
			title: String(it.title ?? "").trim(),
			link: String(it.link ?? "").trim(),
			pubDate: it.pubDate as string | undefined,
			description: it.description as string | undefined,
			guid,
			extra,
		};
	});
}
