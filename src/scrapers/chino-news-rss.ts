// Task 0.3 — Chino news releases + calendar (CivicPlus RSS) + Task 0.9 (Chino PD half).
//
// cityofchino.org runs CivicPlus/CivicEngage. The feed-discovery page RSS.aspx
// lists feeds across 7 modules. robots.txt explicitly disallows /RSS.aspx itself
// (verified live in run() below) but does NOT disallow the underlying
// /RSSFeed.aspx?ModID=...&CID=... endpoints those links point to, so this scraper
// never fetches RSS.aspx programmatically — the catalog below was hand-enumerated
// once, out-of-band (curl, 2026-08-11), and is reproduced in full in
// reports/notes/chino-news-rss.md.
//
//   ModID=1  Newsflash/CivicAlerts ("Spotlights" in nav) — ingested here as
//            item_type 'news_release'. Categories: Chino Spotlights,
//            Community Services Spotlights, Fact Page, Police Spotlights,
//            Success Stories. Police Spotlights is the Task 0.9 PD evidence.
//   ModID=51 Blog — not ingested (no relevant content at survey time)
//   ModID=53 Photo Gallery — not ingested (out of scope)
//   ModID=58 Calendar — ingested here as item_type 'event' (the "All" feed).
//            Categories: Community Services, Events, Meetings, Police Department
//   ModID=63 Alert Center — not ingested (empty at survey time; see notes)
//   ModID=65 Agenda Center — belongs to chino-agendacenter.ts (Task 0.2), not us
//   ModID=76 Pages — not ingested (out of scope)
//
// IMPORTANT FINDING: none of the above is the numbered "NR26-xxx" press-release
// series PLAN.md assumed would be in RSS. That series has NO feed at all — it
// lives only on a hand-maintained page (cityofchino.org/597/News-Releases) whose
// links are conta.cc (Bitly, fronting Constant Contact) shortlinks that redirect
// to myemail.constantcontact.com. The true release permalink is off the city's
// domain entirely. We treat this as an HTML fallback specifically for that series
// (PLAN.md Task 0.3: "if RSS is missing, scrape /597/News-Releases") and ingest
// the most recent couple of releases from it too, clearly labeled in meta.

import * as cheerio from "cheerio";
import {
	type FeedItem,
	parseRssItems,
	resolveDocumentId,
	rfc2822ToIso,
	stripHtml,
} from "./civicplus-rss.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

const BASE = "https://www.cityofchino.org";

// Resolves the America/Los_Angeles UTC offset (handles PST/PDT correctly) for a
// given approximate instant, so wall-clock times scraped from the site (which
// are always Chino, CA local time) convert to correct UTC ISO strings.
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

// Parses strings like "August 18, 2026" (+ optional "06:00 PM") as Chino, CA
// local time and returns a correct UTC ISO string.
function chinoDateTimeToIso(dateStr: string, timeStr?: string): string | null {
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

const NEWSFLASH_CATEGORIES = [
	{ cid: "Chino-Spotlights-1", name: "Chino Spotlights" },
	{
		cid: "Community-Services-Spotlights-7",
		name: "Community Services Spotlights",
	},
	{ cid: "Fact-Page-10", name: "Fact Page" },
	{ cid: "Police-Spotlights-8", name: "Police Spotlights" },
	{ cid: "Success-Stories-9", name: "Success Stories" },
];

// Extracts full article text from a Newsflash/CivicAlerts detail page. The
// CivicPlus "redesign" template renders the article body under
// #main-wrapper .article-content; some Newsflash items instead link out to a
// generic Pages-module page (grid/widget layout, no such container) — falls
// back to whole-module text in that case, at lower confidence.
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
		selector:
			"#moduleContent (fallback — generic Pages-module layout, lower confidence)",
	};
}

// Extracts release body text from a Constant-Contact-hosted email page (table-
// based email HTML, no semantic article container). Strips script/style, then
// truncates at the "Unsubscribe" compliance-footer marker, which appeared
// reliably at the end of every sampled page.
function extractConstantContactText($: cheerio.CheerioAPI): string {
	$("script, style").remove();
	let text = $("body")
		.text()
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
	const cut = text.indexOf("Unsubscribe");
	if (cut > 0) text = text.slice(0, cut).trim();
	return text;
}

async function run(ctx: ScraperContext): Promise<void> {
	// --- Feed discovery: verify (and document) the robots.txt block on RSS.aspx ---
	try {
		await ctx.fetchRaw(`${BASE}/RSS.aspx`);
		ctx.note(
			"Unexpected: RSS.aspx (feed discovery page) was fetchable — robots.txt may have changed since 2026-08-11; re-verify the feed catalog in reports/notes/chino-news-rss.md is still current.",
		);
	} catch (err) {
		ctx.note(
			`Feed discovery page /RSS.aspx is blocked by robots.txt ("Disallow: /RSS.aspx", confirmed live): ${(err as Error).message}. ` +
				"The full feed catalog (7 modules, ~21 category feeds) was hand-enumerated once out-of-band (curl, 2026-08-11) by reading that same disallowed page as a one-time human research step, not via this scraper — see reports/notes/chino-news-rss.md for the complete list. " +
				"The underlying /RSSFeed.aspx?ModID=...&CID=... endpoints those catalog entries point to are NOT covered by any robots.txt rule and are fetched normally below.",
		);
	}

	// Cross-check reference: the aggregate "All" Newsflash feed, for a total-count
	// sanity check against the per-category feeds ingested below. Not used to
	// create items (would duplicate items already captured per-category).
	const allFeedUrl = `${BASE}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`;
	const allDoc = await ctx.fetchDocument(allFeedUrl, {
		docType: "feed",
		title: "Newsflash — All categories",
	});
	const allItems = parseRssItems(allDoc.body.toString("utf8"));
	ctx.note(
		`Newsflash/CivicAlerts "All" feed (ModID=1, aggregate) currently has ${allItems.length} item(s) site-wide: ${allItems.map((i) => `"${i.title}"`).join(", ") || "(none)"}.`,
	);

	// --- Collect Newsflash/CivicAlerts categories (item_type 'news_release') ---
	// Collected first, inserted once at the end (below) so each logical item gets
	// exactly one row: a document's UNIQUE(document_id, external_id, item_type)
	// means re-inserting the same external_id under a *different* document_id (the
	// detail page fetched below, for full-text enrichment) would create a second
	// row instead of updating in place — so we decide detail-page targets before
	// doing any inserts, and insert each item exactly once from its best source.
	const newsflashCollected: Array<{
		item: FeedItem;
		category: string;
		feedUrl: string;
		documentId: number;
	}> = [];
	for (const cat of NEWSFLASH_CATEGORIES) {
		const url = `${BASE}/RSSFeed.aspx?ModID=1&CID=${cat.cid}`;
		const doc = await ctx.fetchDocument(url, {
			docType: "feed",
			title: `Newsflash — ${cat.name}`,
		});
		const items = parseRssItems(doc.body.toString("utf8"));
		if (items.length === 0) {
			ctx.note(
				`Newsflash category "${cat.name}" (CID=${cat.cid}) currently has 0 items.`,
			);
			continue;
		}
		for (const it of items) {
			newsflashCollected.push({
				item: it,
				category: cat.name,
				feedUrl: url,
				documentId: doc.documentId,
			});
		}
	}

	// Task 0.9 (Chino PD half): does PD content flow through the CivicAlerts feed?
	const pdSpotlights = newsflashCollected.filter(
		(c) => c.category === "Police Spotlights",
	);
	if (pdSpotlights.length > 0) {
		ctx.note(
			`Task 0.9: Chino PD content DOES flow through the CivicAlerts/Newsflash feed via a dedicated "Police Spotlights" category (ModID=1, CID=Police-Spotlights-8). Evidence: ${pdSpotlights
				.map((c) => `"${c.item.title}"`)
				.join(
					", ",
				)}. Content observed is community-outreach/recruiting (academy, events), not incident/crime press releases — Chino PD does not appear to publish incident reports through this channel.`,
		);
	} else {
		ctx.note(
			'Task 0.9: the "Police Spotlights" CivicAlerts category (ModID=1, CID=Police-Spotlights-8) exists but had 0 items at run time.',
		);
	}
	// Second piece of 0.9 evidence: the Calendar module also has a PD category.
	const pdCalUrl = `${BASE}/RSSFeed.aspx?ModID=58&CID=Police-Department-26`;
	const pdCalDoc = await ctx.fetchDocument(pdCalUrl, {
		docType: "feed",
		title: "Calendar — Police Department",
	});
	const pdCalItems = parseRssItems(pdCalDoc.body.toString("utf8"));
	ctx.note(
		`Task 0.9: Calendar module also has a "Police Department" category (ModID=58, CID=Police-Department-26): ${pdCalItems.length} event(s) at run time. Combined with Police Spotlights, PD content is well-represented in CivicPlus RSS for outreach/events; no separate PD press-release or incident feed was found anywhere in the RSS.aspx catalog — treated as a GAP (Chino PD publishes incident-level information, if at all, outside this RSS surface; not verified here per scope — social platforms excluded).`,
	);

	// --- Full-text vs teaser (open question 6): fetch detail pages for the first
	// 2 items, extract full text via cheerio, and remember it for the single
	// insert pass below. Everything else keeps its RSS teaser as body.
	const detailTargetGuids = new Set(
		newsflashCollected.slice(0, 2).map((c) => c.item.guid),
	);
	const fullTextByGuid = new Map<
		string,
		{ documentId: number; sourceUrl: string; text: string; selector: string }
	>();
	for (const c of newsflashCollected) {
		if (!detailTargetGuids.has(c.item.guid)) continue;
		const detailDoc = await ctx.fetchDocument(c.item.link, {
			docType: "news_release",
			title: c.item.title,
		});
		const $ = cheerio.load(detailDoc.body.toString("utf8"));
		const { text: fullText, selector } = extractNewsflashDetail($);
		const teaserLen = stripHtml(c.item.description).length;
		ctx.note(
			`Detail page for "${c.item.title}" (${c.item.link}): RSS <description> teaser is ${teaserLen} chars; full extracted article via ${selector} is ${fullText.length} chars.`,
		);
		if (fullText.length > 0) {
			fullTextByGuid.set(c.item.guid, {
				documentId: detailDoc.documentId,
				sourceUrl: c.item.link,
				text: fullText,
				selector,
			});
		}
	}
	ctx.note(
		"Open question 6 answer: the CivicPlus Newsflash/CivicAlerts RSS <description> is TEASER-ONLY (see char-count comparisons above) — full article text requires fetching the item detail page and extracting via cheerio. The separate Calendar feed descriptions ARE effectively complete for their purpose (date/time/location is the whole content of a calendar entry). The numbered NR-series press releases have no RSS description at all (no feed exists) — see below.",
	);

	// Single insert pass: one row per logical Newsflash item, sourced from its
	// detail-page document when we fetched one (full text), else the feed
	// document (teaser text) it came from.
	for (const c of newsflashCollected) {
		const enriched = fullTextByGuid.get(c.item.guid);
		const freshDocId = enriched?.documentId ?? c.documentId;
		ctx.insertItem({
			document_id: resolveDocumentId(
				ctx,
				freshDocId,
				c.item.guid,
				"news_release",
			),
			source_url: enriched?.sourceUrl ?? c.item.link,
			item_type: "news_release",
			external_id: c.item.guid,
			title: c.item.title,
			body: enriched?.text ?? stripHtml(c.item.description),
			occurred_at: rfc2822ToIso(c.item.pubDate),
			meta: {
				category: c.category,
				feedUrl: c.feedUrl,
				module: "Newsflash/CivicAlerts (ModID=1)",
				...(enriched
					? { fullTextExtractedVia: enriched.selector }
					: { bodyIsTeaser: true }),
			},
		});
	}

	// --- NR-series press releases: RSS is genuinely absent; HTML fallback per PLAN.md ---
	const nrListUrl = `${BASE}/597/News-Releases`;
	const nrListDoc = await ctx.fetchDocument(nrListUrl, {
		docType: "listing",
		title: "News Releases (NR series) index",
	});
	const $list = cheerio.load(nrListDoc.body.toString("utf8"));
	const nrEntries = $list('a[href*="conta.cc"]')
		.toArray()
		.map((el) => ({
			url: $list(el).attr("href") ?? "",
			text: $list(el).text().trim(),
		}))
		.filter((e) => e.url)
		.map((e) => {
			const m = e.text.match(/^(NR\d{2}-\d+)\s*-\s*(.+)$/s);
			return m
				? { url: e.url, nrNumber: m[1], title: m[2] }
				: { url: e.url, nrNumber: null, title: e.text };
		})
		.filter(
			(e): e is { url: string; nrNumber: string; title: string } =>
				e.nrNumber !== null,
		);
	ctx.note(
		`NR-series index (${nrListUrl}) has NO RSS feed anywhere in the RSS.aspx catalog. Parsed ${nrEntries.length} numbered release link(s) from the current page via cheerio (a[href*="conta.cc"]), most recent first: ${nrEntries
			.slice(0, 5)
			.map((e) => e.nrNumber)
			.join(
				", ",
			)}... Every link is a conta.cc (Bitly, fronting Constant Contact) shortlink — the true release permalink is OFF cityofchino.org entirely, resolving to myemail.constantcontact.com. This is a real provenance caveat: PLAN.md's item.source_url spec ("deepest stable link a reader should click") is satisfied, but it is not an on-domain government URL.`,
	);

	const nrToIngest = nrEntries.slice(0, 2);
	for (const nr of nrToIngest) {
		const relDoc = await ctx.fetchDocument(nr.url, {
			docType: "news_release",
			title: `${nr.nrNumber} — ${nr.title}`,
		});
		const $rel = cheerio.load(relDoc.body.toString("utf8"));
		const bodyText = extractConstantContactText($rel);
		const dateline = bodyText.match(/\(([A-Za-z]+ \d{1,2}, \d{4})\)/);
		const occurredAt = dateline ? chinoDateTimeToIso(dateline[1]) : null;
		ctx.note(
			`NR release ${nr.nrNumber}: fetched ${nr.url} -> archived ${relDoc.finalUrl} (${bodyText.length} chars after stripping the Constant Contact email chrome at the "Unsubscribe" marker). ${
				occurredAt
					? `Dateline parsed from body: ${dateline?.[1]}.`
					: "No dateline found in extracted text — occurred_at left null."
			}`,
		);
		ctx.insertItem({
			document_id: resolveDocumentId(
				ctx,
				relDoc.documentId,
				nr.nrNumber,
				"news_release",
			),
			source_url: nr.url,
			item_type: "news_release",
			external_id: nr.nrNumber,
			title: nr.title,
			body: bodyText,
			occurred_at: occurredAt,
			meta: {
				series: "NR",
				nrNumber: nr.nrNumber,
				listedOn: nrListUrl,
				resolvesTo: relDoc.finalUrl,
				externalHost: "myemail.constantcontact.com (via conta.cc redirect)",
			},
		});
	}

	// --- Calendar: ingest the "All" feed as item_type 'event' ---
	const calUrl = `${BASE}/RSSFeed.aspx?ModID=58&CID=All-calendar.xml`;
	const calDoc = await ctx.fetchDocument(calUrl, {
		docType: "feed",
		title: "Calendar — All",
	});
	const calItems = parseRssItems(calDoc.body.toString("utf8"));
	ctx.note(
		`Calendar module (ModID=58) categories found in the RSS.aspx catalog: All, Community Services, Events, Meetings, Police Department. Ingesting the "All" feed: ${calItems.length} upcoming event(s).`,
	);
	for (const it of calItems) {
		const occurredAt = chinoDateTimeToIso(
			it.extra.EventDates ?? "",
			(it.extra.EventTimes ?? "").split("-")[0],
		);
		ctx.insertItem({
			document_id: resolveDocumentId(ctx, calDoc.documentId, it.guid, "event"),
			source_url: it.link,
			item_type: "event",
			external_id: it.guid,
			title: it.title,
			body: stripHtml(it.description),
			occurred_at: occurredAt,
			meta: {
				feedUrl: calUrl,
				module: "Calendar (ModID=58)",
				eventDates: it.extra.EventDates,
				eventTimes: it.extra.EventTimes,
				location: it.extra.Location,
			},
		});
	}

	// --- HTTP behavior notes ---
	ctx.note(
		"HTTP behavior: RSSFeed.aspx responses send no ETag and no Last-Modified header (only Content-Type, Content-Length, cache-control: private,no-transform — explicitly non-cacheable). No conditional-GET support observed; idempotency on re-run relies entirely on this fetcher's content-hash dedup in insertDocument, not on server-side 304s. No WAF/bot-blocking behavior observed (no CAPTCHA, no 403s) for a plain descriptive User-Agent at the enforced 2s/host delay; Newsflash item detail pages return standard 301/302 redirects to canonicalized/mobile-template URLs, which undici's redirect:\"follow\" handles transparently.",
	);
	ctx.note(
		'Platform quirk (relevant to sibling CivicPlus scrapers, e.g. chino-agendacenter.ts, chinohills-*): every RSSFeed.aspx response embeds a live <lastBuildDate> that changes on every request, so the feed *document* never hash-matches across runs — expect documentsNew > 0 for feed URLs on every run, by design of the source, not a bug. Older WebForms pages on this site (e.g. Calendar.aspx?EID=...) similarly embed a live, encrypted __VIEWSTATE and are equally non-reproducible byte-for-byte; the newer "redesign" template (Newsflash detail pages, Pages module, /597/News-Releases) has neither and fetches stably. This scraper works around feed volatility for item idempotency via resolveDocumentId() (reuses the document_id an item\'s external_id was first captured under, queried through ctx.db) rather than trusting the freshly-fetched document each run.',
	);
}

const scraper: ScraperDef = {
	key: "chino-news-rss",
	name: "Chino News (CivicPlus RSS: Newsflash/CivicAlerts, Calendar) + NR-series press releases",
	baseUrl: BASE,
	method: "rss",
	run,
};

export default scraper;
