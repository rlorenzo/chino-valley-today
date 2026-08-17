// Phase 4 Task 4.1 — Chino Valley Fire District (chinovalleyfire.org):
// CivicPlus, same platform family as both cities' existing feeds. The fire
// district serves Chino AND Chino Hills, so everything here is local by
// construction. Feed catalog enumerated live 2026-08-17 from /RSS.aspx (NOT
// robots-blocked on this host, unlike cityofchino.org's):
//
//   ModID=1  News Flash    — ingested as 'news_release' (All-newsflash.xml)
//   ModID=51 Blog          — not ingested (out of scope)
//   ModID=53 Photo Gallery — not ingested (out of scope)
//   ModID=58 Calendar      — ingested as 'event' (All-calendar.xml; includes
//                            Events, Meetings, Main Calendar categories)
//   ModID=63 Alert Center  — ingested as 'alert' (All-0). Empty feeds are the
//                            normal state; an item here is an active emergency
//                            notice and the daily brief's highest-value line.
//   ModID=65 Agenda Center — not ingested here (board/committee agendas; a
//                            future governance scraper's job, per the
//                            chino-agendacenter.ts precedent)
//   ModID=76 Pages         — not ingested (out of scope)
import {
	localDateTimeToIso,
	parseRssItems,
	resolveDocumentId,
	rfc2822ToIso,
	stripHtml,
} from "./civicplus-rss.ts";
import type { ScraperDef } from "./types.ts";

const BASE = "https://www.chinovalleyfire.org";

const FEEDS = [
	{
		url: `${BASE}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`,
		title: "CVFD News Flash — All",
		itemType: "news_release",
		module: "Newsflash (ModID=1)",
	},
	{
		url: `${BASE}/RSSFeed.aspx?ModID=63&CID=All-0`,
		title: "CVFD Alert Center — All",
		itemType: "alert",
		module: "Alert Center (ModID=63)",
	},
	{
		url: `${BASE}/RSSFeed.aspx?ModID=58&CID=All-calendar.xml`,
		title: "CVFD Calendar — All",
		itemType: "event",
		module: "Calendar (ModID=58)",
	},
] as const;

const scraper: ScraperDef = {
	key: "cvfd-news",
	name: "Chino Valley Fire District News, Alerts & Calendar",
	baseUrl: BASE,
	method: "rss",
	async run(ctx) {
		for (const feed of FEEDS) {
			const doc = await ctx.fetchDocument(feed.url, {
				docType: "feed",
				title: feed.title,
			});
			const items = parseRssItems(doc.body.toString("utf8"));
			for (const it of items) {
				if (!it.link) continue;
				// Calendar items carry <calendarEvent:*> children; EventDates +
				// EventTimes give the actual event instant (Pacific local), which
				// outranks pubDate (publication instant) — the "one timestamp column,
				// two meanings" lesson. EventTimes is a range ("6:00 PM - 8:00 PM");
				// pass only the start half, matching the validated chino-news-rss
				// pattern — the raw range can regex-match the END time instead.
				const occurredAt =
					feed.itemType === "event" && it.extra.EventDates
						? (localDateTimeToIso(
								it.extra.EventDates,
								(it.extra.EventTimes ?? "").split("-")[0],
							) ?? rfc2822ToIso(it.pubDate))
						: rfc2822ToIso(it.pubDate);
				ctx.insertItem({
					document_id: resolveDocumentId(
						ctx,
						doc.documentId,
						it.guid,
						feed.itemType,
					),
					source_url: it.link,
					item_type: feed.itemType,
					external_id: it.guid,
					title: it.title,
					body: stripHtml(it.description) || null,
					occurred_at: occurredAt,
					meta: {
						feedUrl: feed.url,
						module: feed.module,
						...(it.extra.Location ? { location: it.extra.Location } : {}),
						...(it.extra.EventDates
							? {
									eventDates: it.extra.EventDates,
									eventTimes: it.extra.EventTimes,
								}
							: {}),
					},
				});
			}
			ctx.note(
				`${feed.title}: ${items.length} item(s). ` +
					(feed.itemType === "alert" && items.length === 0
						? "Empty is the normal state for Alert Center — a non-empty run is an active emergency notice."
						: ""),
			);
		}
	},
};

export default scraper;
