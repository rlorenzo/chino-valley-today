// Planes of Fame Air Museum (Chino Airport) — public events calendar.
//
// The second Chino Airport museum in the brief; Yanks Air Museum next door is
// already ingested via the Tribe Events REST API (yanksair-events.ts). Planes
// of Fame is NOT WordPress — /wp-json and the Tribe endpoint both 404 — so
// there is no API and no RSS/iCal anywhere on the site. What it does have is a
// server-rendered listing at /events-calendar with per-event permalinks, which
// is enough: verified live 2026-09-04.
//
// robots.txt (fetched 2026-09-04) disallows only /doc/, /install/, /lib/,
// /modules/, /module_custom/, /plugins/, /scripts/, /tmp/ and /assets/, with
// Allow re-opening /assets/css/, /assets/images/, /assets/sitemaps/ and
// /assets/themes/. /events-calendar is not covered by any rule.
//
// Markup shape (one block per event, 5 on the probe day):
//   <div class="nice-shadow ...">
//     <div class="bold center mb1">5<sup>th</sup> of September, 2026</div>
//     <a href="<permalink>" class="block h3 second-font ...">TITLE</a>
//     <div class="overflow-hidden"><p><p>BODY</p></p></div>
//   </div>
// The header div carries the DATE only. Start times live in the body prose
// ("... Saturday, September 5, 2026 at 10:30am."), so the time is recovered
// from there and the event falls back to all-day when the prose omits one.
//
// Off-site events: the museum lists appearances at other people's airshows
// (e.g. "Central Coast AirFest, September 12-13, 2026, Santa Maria, CA") with
// the anchor pointing at that show's own domain. Those are ingested — the
// archive stays complete — but flagged meta.offsite so the daily brief's Today
// section can drop them; a Santa Maria airshow is not a Chino Valley event.

import * as cheerio from "cheerio";
import { localDateTimeToIso } from "./civicplus-rss.ts";
import { resolveDocumentId } from "./document-linkage.ts";
import { idSlug } from "./external-id.ts";
import type { NewItemInput, ScraperDef } from "./types.ts";

const HOST = "https://planesoffame.org";
const LISTING_URL = `${HOST}/events-calendar`;

export interface PofEvent {
	dateText: string; // "September 5, 2026", normalized for localDateTimeToIso
	timeText: string | null; // "10:30 AM", or null when the prose gives no time
	title: string;
	url: string;
	body: string | null;
	offsite: boolean;
}

// "5th of September, 2026" (the <sup> is stripped by cheerio's .text()) ->
// "September 5, 2026", the shape localDateTimeToIso already parses. Returns
// null rather than guessing when the header is not a date at all.
export function normalizeDateText(raw: string): string | null {
	const m = raw
		.replace(/\s+/g, " ")
		.trim()
		.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([A-Za-z]+),?\s+(\d{4})$/i);
	return m ? `${m[2]} ${m[1]}, ${m[3]}` : null;
}

// Start time out of body prose: "at 10:30am", "at 10:30 a.m.", "at 9am".
// Only the FIRST match is used — a multi-day airshow blurb can mention several
// times, and the first is the one attached to this listing's date.
export function extractTime(body: string | null): string | null {
	if (!body) return null;
	const m = body.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
	if (!m) return null;
	const hour = parseInt(m[1], 10);
	if (hour < 1 || hour > 12) return null;
	return `${hour}:${m[2] ?? "00"} ${m[3].toUpperCase()}M`;
}

// Pure parse over the listing HTML, exported for tests.
export function parseEvents(html: string): PofEvent[] {
	const $ = cheerio.load(html);
	const out: PofEvent[] = [];
	$(".nice-shadow").each((_, el) => {
		const block = $(el);
		const dateText = normalizeDateText(
			block.find(".bold.center").first().text(),
		);
		const anchor = block.find("a.block.h3").first();
		const title = anchor.text().replace(/\s+/g, " ").trim();
		const href = anchor.attr("href")?.trim();
		// A block missing any of the three is not an event block — skip it
		// rather than storing a half-item. Zero events overall is caught in run().
		if (!dateText || !title || !href) return;
		const url = new URL(href, HOST).toString();
		const body =
			block
				.find(".overflow-hidden")
				.first()
				.text()
				.replace(/\s+/g, " ")
				.trim() || null;
		out.push({
			dateText,
			timeText: extractTime(body),
			title,
			url,
			body,
			offsite: new URL(url).host !== new URL(HOST).host,
		});
	});
	return out;
}

export function eventToItem(
	e: PofEvent,
): Omit<NewItemInput, "document_id"> | null {
	const occurredAt = localDateTimeToIso(e.dateText, e.timeText ?? undefined);
	if (!occurredAt) return null;
	const isoDate = occurredAt.slice(0, 10);
	// Prefer the CMS's own permalink slug ("Hangar-Talk-8") — native and stable.
	// Off-site anchors have no such slug, so those fall back to the title. Both
	// are date-prefixed so a reused slug cannot merge two different occurrences.
	const lastSegment = new URL(e.url).pathname.split("/").filter(Boolean).pop();
	const discriminator = e.offsite || !lastSegment ? e.title : lastSegment;
	return {
		source_url: e.url,
		item_type: "event",
		external_id: `${isoDate}-${idSlug(discriminator).slice(0, 60)}`,
		title: e.title,
		body: e.body,
		occurred_at: occurredAt,
		meta: {
			host: "planesoffame.org",
			venue: e.offsite ? null : "Planes of Fame Air Museum",
			// No time in the prose means the listing gave us a date only; the
			// brief renders "all day" rather than inventing midnight.
			allDay: e.timeText === null,
			offsite: e.offsite,
		},
	};
}

const scraper: ScraperDef = {
	key: "planesoffame-events",
	name: "Planes of Fame Air Museum (events calendar)",
	baseUrl: HOST,
	method: "html",
	async run(ctx) {
		const doc = await ctx.fetchDocument(LISTING_URL, {
			docType: "listing",
			title: "Planes of Fame Air Museum — Events Calendar",
		});
		const events = parseEvents(doc.body.toString("utf8"));
		if (events.length === 0) {
			// This calendar is never empty in practice — the Hangar Talk series
			// runs monthly and the page always lists several months ahead. Zero
			// parsed blocks means the markup moved, which is a failure, not a
			// quiet day. Throwing is what run-one.ts reads as a failed run
			// (chinohills-swagit precedent).
			throw new Error(
				`No parsable event blocks found at ${LISTING_URL} — the .nice-shadow / ` +
					".bold.center / a.block.h3 markup this scraper depends on has probably changed.",
			);
		}

		let stored = 0;
		let offsite = 0;
		let undated = 0;
		for (const e of events) {
			const item = eventToItem(e);
			if (!item) {
				undated++;
				ctx.note(
					`Event "${e.title}" (${e.url}) has an unparseable date header ("${e.dateText}") — not stored.`,
				);
				continue;
			}
			ctx.insertItem({
				...item,
				document_id: resolveDocumentId(
					ctx,
					doc.documentId,
					item.external_id,
					item.item_type,
				),
			});
			stored++;
			if (e.offsite) offsite++;
		}
		ctx.note(
			`${LISTING_URL}: stored ${stored} of ${events.length} parsed event block(s)` +
				`${undated ? `, ${undated} skipped for an unparseable date` : ""}. ` +
				`${offsite} are off-site appearances at other venues (flagged meta.offsite, ` +
				"excluded from the brief's Today section). " +
				`${events.filter((e) => e.timeText === null).length} carried no start time in the ` +
				"body prose and are stored as all-day.",
		);
		ctx.note(
			"No API: planesoffame.org is not WordPress (/wp-json and the Tribe events endpoint " +
				"both 404) and publishes no RSS or iCal. The server-rendered /events-calendar listing " +
				"is the only machine-readable surface, and robots.txt does not restrict it.",
		);
	},
};

export default scraper;
