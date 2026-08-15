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

// Re-exported so the CivicPlus scrapers keep a single import site.
export { resolveDocumentId } from "./document-linkage.ts";

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
