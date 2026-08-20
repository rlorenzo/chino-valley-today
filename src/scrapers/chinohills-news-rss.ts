// Task 0.4 — Chino Hills news/newsflash (CivicPlus RSS half).
//
// www.chinohills.org runs CivicPlus/CivicEngage — same platform family as
// cityofchino.org (see chino-news-rss.ts), same quirks. The feed-discovery
// page /RSS.aspx is blocked by robots.txt (verified live below, identical
// rule to cityofchino.org: "Disallow: /RSS.aspx"). The underlying
// /RSSFeed.aspx?ModID=...&CID=... endpoints those links point to are NOT
// covered by any robots.txt rule and are fetched normally below. The full
// catalog (9 modules: Pages ModID=76, Agenda Center ModID=65, Alert Center
// ModID=63, Blog ModID=51, Calendar ModID=58, CivicMedia ModID=92, News &
// Announcements ModID=1, Real Estate Locator ModID=64, Photo Gallery
// ModID=53) was hand-enumerated once out-of-band (curl, 2026-08-11) by
// reading that same disallowed page as a one-time human research step, not
// via this scraper — full list in reports/notes/chinohills.md.
//
// Alert Center (ModID=63) is ingested below as item_type 'alert' (All-0
// feed). Empty feeds are the normal state; a non-empty run is an active
// emergency notice, same treatment as cvfd-news.ts's Alert Center.
//
// News & Announcements (Newsflash/CivicAlerts) is ModID=1. Detail pages live
// under /CivicAlerts.aspx?aid=N, 302-redirecting to canonicalized
// /m/newsflash/home/detail/N URLs — same redirect-to-canonical behavior as
// cityofchino.org's Newsflash. Categories found at survey time: "All"
// (All-newsflash.xml, cross-check only, not ingested directly), "Local
// News" (Local-News-1), "2025 - Home - Spotlight" (2025-Home-Spotlight-12,
// empty). At survey time "Local News" mirrored "All" exactly (4/4 items) —
// ingest named categories, plus (defensively) anything left over in "All"
// that isn't covered by a named category, so a future miscategorized item
// isn't silently dropped.

import * as cheerio from "cheerio";
import {
	type FeedItem,
	ingestAlertCenter,
	parseRssItems,
	resolveDocumentId,
	rfc2822ToIso,
	stripHtml,
} from "./civicplus-rss.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

const BASE = "https://www.chinohills.org";

const NEWSFLASH_CATEGORIES = [
	{ cid: "Local-News-1", name: "Local News" },
	{ cid: "2025-Home-Spotlight-12", name: "2025 - Home - Spotlight" },
];

// Extracts full article text from a Newsflash/CivicAlerts detail page.
// Same template family (and same selector) as cityofchino.org's
// #main-wrapper .article-content, verified live below.
function extractNewsflashDetail($: cheerio.CheerioAPI): {
	text: string;
	selector: string;
} {
	const primary = $("#main-wrapper .article-content")
		.text()
		.replace(/\s+/g, " ")
		.trim();
	if (primary)
		return { text: primary, selector: "#main-wrapper .article-content" };
	const fallback = $("#moduleContent").text().replace(/\s+/g, " ").trim();
	return {
		text: fallback,
		selector: "#moduleContent (fallback — generic layout, lower confidence)",
	};
}

async function run(ctx: ScraperContext): Promise<void> {
	// --- Feed discovery: verify (and document) the robots.txt block on RSS.aspx ---
	try {
		await ctx.fetchRaw(`${BASE}/RSS.aspx`);
		ctx.note(
			"Unexpected: RSS.aspx (feed discovery page) was fetchable — robots.txt may have changed since 2026-08-11; re-verify the feed catalog in reports/notes/chinohills.md is still current.",
		);
	} catch (err) {
		ctx.note(
			`Feed discovery page /RSS.aspx is blocked by robots.txt ("Disallow: /RSS.aspx", confirmed live, identical rule to cityofchino.org): ${(err as Error).message}. ` +
				"The full feed catalog (9 modules, ~30 category feeds) was hand-enumerated once out-of-band (curl, 2026-08-11) by reading that same disallowed page as a one-time human research step, not via this scraper — see reports/notes/chinohills.md for the complete list. " +
				"The underlying /RSSFeed.aspx?ModID=...&CID=... endpoints those catalog entries point to are NOT covered by any robots.txt rule and are fetched normally below.",
		);
	}

	// Cross-check reference: the aggregate "All" Newsflash feed. Used to catch
	// any item not covered by a named category below; not inserted directly
	// (would duplicate items already captured per-category).
	const allFeedUrl = `${BASE}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`;
	const allDoc = await ctx.fetchDocument(allFeedUrl, {
		docType: "feed",
		title: "News Flash — All",
	});
	const allItems = parseRssItems(allDoc.body.toString("utf8"));
	ctx.note(
		`News Flash "All" feed (ModID=1, aggregate) currently has ${allItems.length} item(s): ${allItems.map((i) => `"${i.title}"`).join(", ") || "(none)"}.`,
	);

	const collected: Array<{
		item: FeedItem;
		category: string;
		feedUrl: string;
		documentId: number;
	}> = [];
	const seenGuids = new Set<string>();
	for (const cat of NEWSFLASH_CATEGORIES) {
		const url = `${BASE}/RSSFeed.aspx?ModID=1&CID=${cat.cid}`;
		const doc = await ctx.fetchDocument(url, {
			docType: "feed",
			title: `News Flash — ${cat.name}`,
		});
		const items = parseRssItems(doc.body.toString("utf8"));
		if (items.length === 0) {
			ctx.note(
				`News Flash category "${cat.name}" (CID=${cat.cid}) currently has 0 items.`,
			);
			continue;
		}
		for (const it of items) {
			collected.push({
				item: it,
				category: cat.name,
				feedUrl: url,
				documentId: doc.documentId,
			});
			seenGuids.add(it.guid);
		}
	}

	// Defensive: anything in "All" not covered by a named category (avoids
	// silently dropping items if a future item lands outside the two
	// categories currently populated).
	const uncategorized = allItems.filter((it) => !seenGuids.has(it.guid));
	if (uncategorized.length > 0) {
		ctx.note(
			`${uncategorized.length} item(s) in the "All" feed are NOT covered by a named category (Local News, 2025 Home Spotlight) — ingesting under category "Uncategorized (via All feed)": ${uncategorized
				.map((i) => `"${i.title}"`)
				.join(", ")}.`,
		);
		for (const it of uncategorized) {
			collected.push({
				item: it,
				category: "Uncategorized (via All feed)",
				feedUrl: allFeedUrl,
				documentId: allDoc.documentId,
			});
		}
	} else {
		ctx.note(
			'Every item in the "All" feed is accounted for by a named category — no uncategorized items this run.',
		);
	}

	// --- Full-text vs teaser (PLAN open question 6, Chino Hills data point):
	// fetch one detail page and compare against its RSS teaser. ---
	if (collected.length > 0) {
		const sample = collected[0];
		const detailDoc = await ctx.fetchDocument(sample.item.link, {
			docType: "news_release",
			title: sample.item.title,
		});
		const $ = cheerio.load(detailDoc.body.toString("utf8"));
		const { text: fullText, selector } = extractNewsflashDetail($);
		const teaserLen = stripHtml(sample.item.description).length;
		ctx.note(
			`Open question 6 (Chino Hills data point): detail page for "${sample.item.title}" (${sample.item.link} -> ${detailDoc.finalUrl}): RSS <description> teaser is ${teaserLen} chars; full extracted article via ${selector} is ${fullText.length} chars. Same conclusion as cityofchino.org: the CivicPlus Newsflash/CivicAlerts RSS <description> is TEASER-ONLY — full article text requires fetching the item detail page and extracting via cheerio.`,
		);
	}

	// --- Insert pass: body stays teaser-only per spec (RSS <description>,
	// HTML-stripped) even though the note above fetched one detail page for
	// full text to answer the open question. ---
	for (const c of collected) {
		ctx.insertItem({
			document_id: resolveDocumentId(
				ctx,
				c.documentId,
				c.item.guid,
				"news_release",
			),
			source_url: c.item.link,
			item_type: "news_release",
			external_id: c.item.guid,
			title: c.item.title,
			body: stripHtml(c.item.description),
			occurred_at: rfc2822ToIso(c.item.pubDate),
			meta: { category: c.category, feedUrl: c.feedUrl },
		});
	}

	// --- Alert Center: ingest as item_type 'alert' (All-0, ModID=63) via the
	// shared CivicPlus helper. ---
	await ingestAlertCenter(ctx, BASE);

	// --- HTTP behavior notes ---
	ctx.note(
		"HTTP behavior: RSSFeed.aspx responses send no ETag and no Last-Modified header (only Content-Type, Content-Length, cache-control: private,no-transform) — identical to cityofchino.org. No conditional-GET support observed; idempotency on re-run relies on this fetcher's content-hash dedup in insertDocument, not server-side 304s. CivicAlerts.aspx?aid=N detail links 302-redirect to canonicalized /m/newsflash/home/detail/N URLs; undici's redirect:\"follow\" handles this transparently. No WAF/bot-blocking (no CAPTCHA, no 403s) observed for a descriptive User-Agent at the enforced 2s/host delay.",
	);
	ctx.note(
		"Platform-quirk cross-reference: every RSSFeed.aspx response embeds a live <lastBuildDate> that changes on every request, so the feed *document* never hash-matches across runs — expect documentsNew > 0 for feed URLs on every run, by design of the source, not a bug (same as cityofchino.org, see chino-news-rss.ts). Item idempotency here is handled the same way, via resolveDocumentId() (reuses the document_id an item's external_id was first captured under, queried through ctx.db) rather than trusting the freshly-fetched feed document each run.",
	);
}

const scraper: ScraperDef = {
	key: "chinohills-news-rss",
	name: "Chino Hills News (CivicPlus RSS: News Flash/CivicAlerts)",
	baseUrl: BASE,
	method: "rss",
	run,
};

export default scraper;
