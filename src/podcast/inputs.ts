// What the weekly podcast is allowed to talk about: last week's published
// posts, and the week ahead.
//
// Both halves are read back out of what the site already published rather than
// re-derived from the item tables. The episode is a review OF the record, so
// anything it mentions has already been through the gates once, and the URL it
// cites is a page a listener can actually open.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePostFile } from "../admin/render.ts";
import type { Db } from "../db/index.ts";
import {
	CALENDAR_SOURCES,
	railEntries,
	selectUpcomingEvents,
} from "../pipeline/daily-brief.ts";
import { type BriefEventAhead, listPosts } from "../pipeline/posts.ts";
import { SITE_ORIGIN } from "../pipeline/site-url.ts";
import { ROOT } from "../store.ts";
import { queryItems } from "../tiera/queries.ts";
import { localMeetingDate } from "../tiera/util.ts";

export interface PodcastPost {
	slug: string;
	title: string;
	url: string;
	publishedAt: string;
	bodyMd: string;
}

export interface PodcastInputs {
	posts: PodcastPost[];
	events: BriefEventAhead[];
}

// A post digesting the record rather than entering it is not a story to review:
// the brief is a daily assembly of the same posts, and last week's podcast is
// this one talking about itself.
const EXCLUDED_TYPES = new Set(["daily-brief", "podcast"]);

/**
 * An instant that lands on `laDate` in BOTH the Pacific and the UTC calendar.
 *
 * Callers read one projection or the other and must agree: isoWeekOf() works
 * on UTC fields, while selectUpcomingEvents() projects to the Pacific day.
 * 19:00Z is late morning Pacific whether the offset is -7 or -8, so this needs
 * no DST branch — which midnight Pacific, the natural spelling, would.
 */
export function pacificDay(laDate: string): Date {
	return new Date(`${laDate}T19:00:00Z`);
}

/** YYYY-MM-DD plus N calendar days, on UTC fields, so DST cannot shift it. */
export function laDatePlusDays(laDate: string, days: number): string {
	const [y, m, d] = laDate.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * `monday` is any instant on the episode's Monday, Pacific.
 *
 * The window is compared as Pacific CALENDAR DAYS, not as instants seven days
 * apart: an instant window drifts by an hour across a DST boundary and would
 * move a Sunday-evening post in or out of the episode twice a year.
 */
export function podcastInputs(db: Db, monday: Date): PodcastInputs {
	const mondayDate = localMeetingDate(monday.toISOString());
	if (!mondayDate) throw new Error(`unusable episode date: ${monday}`);
	const weekStart = laDatePlusDays(mondayDate, -7);

	const posts: PodcastPost[] = [];
	for (const row of listPosts(db, "published")) {
		if (EXCLUDED_TYPES.has(row.post_type)) continue;
		if (!row.published_at) continue;
		const day = localMeetingDate(row.published_at);
		if (day === null || day < weekStart || day >= mondayDate) continue;
		const parsed = parsePostFile(
			readFileSync(join(ROOT, row.file_path), "utf8"),
		);
		posts.push({
			slug: row.slug,
			title: parsed.title || row.slug,
			// Astro's glob loader lowercases the filename into the collection id and
			// routes /posts/<id>/ (see postUrl in site/src/lib/record.ts). createPost
			// normalizes the stored slug to match, so the stored slug IS the id.
			url: `${SITE_ORIGIN}/posts/${row.slug}/`,
			publishedAt: row.published_at,
			bodyMd: parsed.body,
		});
	}
	posts.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

	// The brief's own week-ahead rail, asked for a different week. Anchored on
	// the SUNDAY before the episode because selectUpcomingEvents is exclusive of
	// its anchor day, so a 7-day horizon from Sunday is Monday..Sunday — the
	// week the episode previews.
	const events = railEntries(
		selectUpcomingEvents(
			queryItems(db, { sourceKeys: CALENDAR_SOURCES, itemTypes: ["event"] }),
			pacificDay(laDatePlusDays(mondayDate, -1)),
			7,
		),
		(url) => url,
	);

	return { posts, events };
}
