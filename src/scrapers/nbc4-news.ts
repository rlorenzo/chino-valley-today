// NBC4 Los Angeles — a regional broadcaster, so ingest is gated by a Chino
// keyword filter at scrape time rather than relying on daily-brief's
// relevance pass alone: without it this source would archive the whole LA
// news feed. Only the exact feed URL below is robots-Allowed; the plain
// ?rss=y variant is not (verified 2026-08-19) — do not swap it for a
// shorter-looking equivalent. <description> in this feed carries the FULL
// article text, so the teaser truncation in feed-press.ts is load-bearing
// here: the raw description must never reach `body`.

import { cleanPlainText } from "../utils/text-truncation.ts";
import { laOffsetMinutes } from "./civicplus-rss.ts";
import type { FeedPressItem } from "./feed-press.ts";
import { runFeedPress } from "./feed-press.ts";
import type { ScraperDef } from "./types.ts";

const CHINO_RE = /\bchino(\s+hills)?\b/i;

function chinoKeywordFilter(
	item: FeedPressItem,
): Record<string, unknown> | null {
	const titleMatch = (item.title ?? "").match(CHINO_RE);
	if (titleMatch) return { chinoKeyword: titleMatch[0] };

	const descriptionMatch = cleanPlainText(item.description ?? "").match(
		CHINO_RE,
	);
	if (descriptionMatch) return { chinoKeyword: descriptionMatch[0] };

	return null;
}

// This feed's pubDate omits a UTC offset ("Wed, Aug 19 2026 06:13:12 PM"),
// unlike the three WordPress student-paper feeds' standard RFC 2822
// timestamps. feed-press.ts's default parser is a bare `new Date()`, which
// resolves a missing offset against the RUNNING PROCESS's own timezone —
// correct only by accident on a host already set to Pacific, silently wrong
// by several hours everywhere else (a UTC CI runner or production host).
// NBC4's newsroom publishes Pacific local time, so that's parsed explicitly
// here instead of trusting the environment.
const NBC4_PUBDATE_RE =
	/^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i;

const MONTH_ABBR = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

export function nbc4PubDateToIso(pubDate: string | undefined): string | null {
	if (!pubDate) return null;
	const m = pubDate.trim().match(NBC4_PUBDATE_RE);
	if (!m) {
		// Format changed back to a standard, offset-bearing RFC 2822 string —
		// a bare parse is then correct and timezone-independent.
		const d = new Date(pubDate);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}
	const [, monName, dayStr, yearStr, hourStr, minStr, secStr, ampm] = m;
	const mo = MONTH_ABBR.indexOf(monName.slice(0, 3).toLowerCase());
	if (mo < 0) return null;
	let hour = parseInt(hourStr, 10) % 12;
	if (/pm/i.test(ampm)) hour += 12;
	const naiveUtc = Date.UTC(
		parseInt(yearStr, 10),
		mo,
		parseInt(dayStr, 10),
		hour,
		parseInt(minStr, 10),
		parseInt(secStr, 10),
	);
	return new Date(naiveUtc - laOffsetMinutes(naiveUtc) * 60000).toISOString();
}

const scraper: ScraperDef = {
	key: "nbc4-news",
	name: "NBC4 Los Angeles",
	baseUrl: "https://www.nbclosangeles.com",
	method: "rss",
	fetchDefaults: {
		failClosedRobots: true,
		manualRedirect: true,
		allowedHosts: ["www.nbclosangeles.com", "nbclosangeles.com"],
		maxRedirectHops: 3,
	},
	async run(ctx) {
		await runFeedPress(ctx, {
			outlet: "NBC4 Los Angeles",
			feedUrl: "https://www.nbclosangeles.com/?rss=y&most_recent=y",
			filterItem: chinoKeywordFilter,
			parsePubDate: nbc4PubDateToIso,
		});
	},
};

export default scraper;
