// Shared plumbing for the two CivicPlus RSS scrapers (chino-news-rss.ts and
// chinohills-news-rss.ts). Both cities run the same CivicPlus product, so both
// scrapers had byte-identical copies of everything here — 181 duplicated lines
// across 6 clone groups before this module existed.
//
// Only genuinely city-agnostic code belongs here. Anything that encodes one
// city's feed layout, category ids, or relevance rules stays in that city's
// scraper.
import { XMLParser } from "fast-xml-parser";
import { cleanPlainText } from "../utils/text-truncation.ts";

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
	return input ? cleanPlainText(input) : "";
}

export function rfc2822ToIso(pubDate: string | undefined): string | null {
	if (!pubDate) return null;
	const d = new Date(pubDate);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Resolves the America/Los_Angeles UTC offset (handles PST/PDT correctly) for a
// given approximate instant, so wall-clock times scraped from a site (which are
// always Chino-area local time) convert to correct UTC ISO strings.
// Moved here from chino-news-rss.ts (2026-08-17) when cvfd-news.ts became the
// second CivicPlus scraper needing it — it is city-agnostic by construction.
function laOffsetMinutes(approxUtcMs: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		timeZoneName: "longOffset",
	}).formatToParts(new Date(approxUtcMs));
	const m = (
		parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00"
	).match(/GMT([+-])(\d{2}):(\d{2})/);
	if (!m) return -480;
	return (
		(m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10))
	);
}

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

// Parses strings like "August 18, 2026" (+ optional "06:00 PM") as
// America/Los_Angeles local time and returns a correct UTC ISO string.
export function localDateTimeToIso(
	dateStr: string,
	timeStr?: string,
): string | null {
	const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
	if (!dm) return null;
	const mo = MONTHS.indexOf(dm[1].toLowerCase());
	if (mo < 0) return null;
	const day = parseInt(dm[2], 10);
	const year = parseInt(dm[3], 10);
	let hour = 0;
	let minute = 0;
	if (timeStr) {
		const tm = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
		if (tm) {
			hour = parseInt(tm[1], 10) % 12;
			minute = parseInt(tm[2], 10);
			if (/pm/i.test(tm[3])) hour += 12;
		}
	}
	const naiveUtc = Date.UTC(year, mo, day, hour, minute);
	return new Date(naiveUtc - laOffsetMinutes(naiveUtc) * 60000).toISOString();
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
