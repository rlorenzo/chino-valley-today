// Shared plumbing for the four secondary-press sources that are exactly one
// RSS feed fetched per run: three student papers (Quest News, Bulldog Times,
// The Breeze) and NBC4 Los Angeles. All four publish standard WordPress-family
// RSS 2.0 (title/link/guid/pubDate/description[/content:encoded]), so parsing
// and ingest are identical; only the feed URL, outlet label, allowed hosts,
// and per-item extras (a fixed city tag vs. NBC4's Chino keyword filter) vary
// between sources. Same shared-core/thin-module split as tribe-events.ts.

import { truncateToSentenceBoundary } from "../utils/text-truncation.ts";
import { rfc2822ToIso, toArray, xmlParser } from "./civicplus-rss.ts";
import { resolveDocumentId } from "./document-linkage.ts";
import { TEASER_MAX_CHARS, TEASER_MAX_WORDS } from "./press-article.ts";
import type { ScraperContext } from "./types.ts";

const ITEM_TYPE = "news_article";

export interface FeedPressItem {
	title: string;
	link: string;
	// RSS guid, falling back to link when the feed omits one — resolved here
	// so every caller sees the same external_id source without repeating the
	// fallback rule.
	guid: string;
	pubDate?: string;
	description?: string;
	contentEncoded?: string;
}

/** Parses a standard RSS 2.0 <channel><item> feed, WordPress or otherwise. */
export function parseFeedItems(xml: string): FeedPressItem[] {
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
		const guidField = it.guid as
			| { "#text"?: string | number }
			| string
			| number
			| undefined;
		const rawGuid =
			(typeof guidField === "object" ? guidField?.["#text"] : guidField) ?? "";
		const link = String(it.link ?? "").trim();
		const guid = String(rawGuid).trim() || link;
		return {
			title: String(it.title ?? "").trim(),
			link,
			guid,
			pubDate: it.pubDate as string | undefined,
			description: it.description as string | undefined,
			contentEncoded: it["content:encoded"] as string | undefined,
		};
	});
}

/**
 * Tier A rule: verbatim feed text only. Prefers <description>; some feeds
 * (The Breeze) ship it empty and carry the real text in <content:encoded>
 * instead. Either way the result is sentence-truncated to the EDITORIAL.md
 * excerpt limit — for NBC4 in particular, whose <description> carries the
 * full article body, this is what keeps a teaser from becoming a copy.
 */
export function extractTeaser(item: FeedPressItem): string | null {
	const raw = item.description?.trim() ? item.description : item.contentEncoded;
	if (!raw?.trim()) return null;
	return truncateToSentenceBoundary(raw, TEASER_MAX_CHARS, TEASER_MAX_WORDS);
}

export interface FeedPressSourceConfig {
	outlet: string;
	feedUrl: string;
	// Merged onto every stored item's meta (e.g. { city: "Chino" }). Omit for
	// outlets with no fixed local tag (The Breeze).
	extraMeta?: Record<string, unknown>;
	// Per-item gate + extra meta, e.g. NBC4's Chino keyword filter. Returning
	// null skips the item (counted separately in the run note); a non-null
	// object is merged onto the stored item's meta. Omit to ingest every item.
	filterItem?: (item: FeedPressItem) => Record<string, unknown> | null;
	// Overrides how pubDate becomes occurred_at. Default is rfc2822ToIso — a
	// bare `new Date()` parse, correct for the three WordPress feeds' standard
	// RFC 2822 timestamps (explicit offset). NBC4's feed omits the offset, so
	// it supplies its own outlet-specific parser rather than trusting the
	// process's local timezone.
	parsePubDate?: (pubDate: string | undefined) => string | null;
}

/** Fetches and ingests one feed as item_type 'news_article' rows. */
export async function runFeedPress(
	ctx: ScraperContext,
	cfg: FeedPressSourceConfig,
): Promise<void> {
	const doc = await ctx.fetchDocument(cfg.feedUrl, {
		docType: "feed",
		title: `${cfg.outlet} — feed`,
	});
	const items = parseFeedItems(doc.body.toString("utf8"));
	const parsePubDate = cfg.parsePubDate ?? rfc2822ToIso;

	let ingested = 0;
	let filteredOut = 0;

	for (const it of items) {
		if (!it.link || !it.title) continue;

		let extra: Record<string, unknown> = {};
		if (cfg.filterItem) {
			const result = cfg.filterItem(it);
			if (result === null) {
				filteredOut++;
				continue;
			}
			extra = result;
		}

		ctx.insertItem({
			document_id: resolveDocumentId(ctx, doc.documentId, it.guid, ITEM_TYPE),
			source_url: it.link,
			item_type: ITEM_TYPE,
			external_id: it.guid,
			title: it.title,
			body: extractTeaser(it),
			occurred_at: parsePubDate(it.pubDate),
			meta: {
				outlet: cfg.outlet,
				feedUrl: cfg.feedUrl,
				...cfg.extraMeta,
				...extra,
			},
		});
		ingested++;
	}

	ctx.note(
		`${cfg.outlet}: ${items.length} feed item(s), ${ingested} ingested` +
			(cfg.filterItem ? `, ${filteredOut} filtered out` : "") +
			". A 0-item run is normal for this source.",
	);
}
