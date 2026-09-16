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
import {
	type BriefEventAhead,
	listPosts,
	type NewPost,
	type PostRow,
} from "../pipeline/posts.ts";
import { SITE_ORIGIN } from "../pipeline/site-url.ts";
import { ROOT } from "../store.ts";
import { queryItems } from "../tiera/queries.ts";
import {
	alertPostSlugHashOf,
	dedupeByKey,
	localMeetingDate,
} from "../tiera/util.ts";

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
// the brief is a daily assembly of the same posts, the weekly news_digest is a
// roundup of them, and last week's podcast is this one talking about itself.
// Feeding one back in makes the episode recap a recap — and because digest
// entries are truncated teasers, the generator completes the ellipsis and
// invents detail (see truncateTeaser in ../tiera/util.ts).
//
// Typed against the NewPost union so a separator typo ("news-digest") is a
// build error rather than a filter that silently stops filtering.
// src/pipeline/topics.ts has a near-twin, UNTOPICED_POST_TYPES, that answers a
// different question; the two are intentionally not shared.
const EXCLUDED_TYPES: ReadonlySet<string> = new Set<NewPost["postType"]>([
	"daily-brief",
	"news_digest",
	"podcast",
]);

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
 * The oldest episode held for audio — its render failed, or a human approved
 * it in the dashboard — or undefined if there is no backlog.
 *
 * An episode held this way is a work item, not a property of today's date. The
 * podcast timer fires Mondays only, so keying the resume off the current week's
 * slug strands anything approved Tuesday through Sunday: the next firing
 * computes the NEXT week's slug and generates a fresh episode over the top of
 * it. Callers derive the week from this row's `meeting_date` instead.
 */
export function pendingAudioEpisode(db: Db): PostRow | undefined {
	// listPosts is created_at DESC, so findLast is the oldest.
	return listPosts(db, "held").findLast(
		(p) => p.post_type === "podcast" && p.held_reason?.startsWith("audio:"),
	);
}

// Last week's weather already happened. A heat advisory that expired on
// Thursday is not news on Monday, and the W38 draft spent three of its turns
// on expired advisories — the single least interesting thing in the episode.
//
// Expiry cannot be the test, even though every alert carries one: generateAlerts
// mints a post only for an advisory still in force (src/tiera/alerts.ts), so by
// Monday nearly every alert post in the window has lapsed, the consequential
// ones included. The test is what KIND of weather it was — whether anything is
// left to say once the forecast runs out. Flooding leaves damage behind; a
// tsunami is an event that happened. Heat, wind, fog, frost, air quality and
// fire WEATHER are all forecasts of risk, and a risk that did not materialise
// is not a story. One that did arrives as a sheriff's release instead.
//
// Written as a keep-list rather than a drop-list so an NWS product nobody
// anticipated is dropped rather than kept: a miss costs one dull turn, which is
// the thing being fixed, not a wrong one.
const CONSEQUENTIAL_WEATHER_RE = /\b(flood|tsunami)/i;

// A title carried in this many CONSECUTIVE weeks is a standing program —
// Preschool Storytime, Craft Corner, Movers and Shakers — not something that
// happened to be scheduled this week. Measured over the whole calendar the
// split is unambiguous: recurring library programs run 6 to 8 weeks unbroken
// and 112 titles appear in exactly one week, so three is clear of both.
//
// Consecutive, not merely distinct, because the calendar accumulates: counting
// distinct weeks over all history makes any title standing eventually, and the
// casualties are exactly the events the episode exists to name. "City Council
// - Regular Meeting" on the first and third Tuesday reaches three distinct
// weeks in a month and an annual parade reaches it in three years; neither
// reaches two weeks in a row, ever.
//
// The run must also CONTAIN the episode's own week, not merely land on the
// right side of it: a summer series that ended in August would otherwise keep
// suppressing an isolated September revival for as long as the August rows are
// stored, and a seasonal series starting in November would suppress it too —
// the calendar query has no upper bound either.
const RECURRING_WEEK_THRESHOLD = 3;

function normalizeTitle(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Which Monday–Sunday week a Pacific calendar day falls in, as an integer, so
 * "the week after" is `+ 1` rather than string math over ISO week-years.
 * The boundary is not arbitrary: it has to be the episode's own Monday–Sunday
 * week, or a series whose first occurrence is Thursday through Sunday lands in
 * the NEXT bucket and misses the anchor. The `+ 3` shifts epoch day 0, a
 * Thursday, back onto a Monday.
 */
function weekIndexOf(occurredAt: string | null): number | null {
	if (!occurredAt) return null;
	const day = localMeetingDate(occurredAt);
	if (!day) return null;
	const [y, m, d] = day.split("-").map(Number);
	return Math.floor((Date.UTC(y, m - 1, d) / 86_400_000 + 3) / 7);
}

/**
 * Titles that recur week after week as of `anchorDate` (YYYY-MM-DD, the
 * episode's Monday). The week-ahead segment is for what makes this week
 * different from the last one; a program that runs every Tuesday is not that,
 * and 41 events of which 28 are storytimes bury the one that is.
 *
 * A weekly program always has an occurrence in the anchor's own Monday–Sunday
 * week, whatever weekday it runs on, so requiring the run to span it costs
 * nothing for a live series, expires a finished one, and ignores a disconnected
 * series months out. A run that starts in the anchor week and continues forward
 * still qualifies.
 */
export function standingProgramTitles(
	items: { title: string | null; occurred_at: string | null }[],
	anchorDate: string,
): Set<string> {
	const anchorWeek = weekIndexOf(anchorDate);
	if (anchorWeek === null) throw new Error(`unusable anchor: ${anchorDate}`);
	const weeks = new Map<string, Set<number>>();
	for (const item of items) {
		const title = item.title ? normalizeTitle(item.title) : "";
		const week = weekIndexOf(item.occurred_at);
		if (!title || week === null) continue;
		let seen = weeks.get(title);
		if (!seen) {
			seen = new Set();
			weeks.set(title, seen);
		}
		seen.add(week);
	}
	const standing = new Set<string>();
	for (const [title, seen] of weeks) {
		// Only the run through the anchor's own week counts. Walking outward from
		// it — rather than scanning every run and testing its bounds — is the same
		// answer in fewer lines: a run elsewhere in the calendar, past OR future,
		// never reaches the anchor and so never gets counted.
		//
		// Both walks stop at the threshold: only whether the run REACHES it is
		// used, and a program running since the first scrape has a run as long as
		// the stored history, which grows every week.
		if (!seen.has(anchorWeek)) continue;
		let run = 1;
		for (let w = anchorWeek - 1; run < RECURRING_WEEK_THRESHOLD; w--) {
			if (!seen.has(w)) break;
			run++;
		}
		for (let w = anchorWeek + 1; run < RECURRING_WEEK_THRESHOLD; w++) {
			if (!seen.has(w)) break;
			run++;
		}
		if (run >= RECURRING_WEEK_THRESHOLD) standing.add(title);
	}
	return standing;
}

/**
 * One listing per title per day. Two calendars carrying the same meeting is
 * routine — W38 had "City Council - Regular Meeting" twice — and a script that
 * reads both sounds broken. Which of two listings survives is arbitrary — they
 * name the same event — so dedupeByKey's last-wins is as good as first-wins.
 */
export function dedupeEvents<T extends { title: string; date: string }>(
	events: T[],
): T[] {
	return dedupeByKey(events, (e) => `${e.date}|${normalizeTitle(e.title)}`);
}

/**
 * A past-week weather advisory with nothing left to say by Monday.
 *
 * Gated on the slug marker and not on `post_type` alone, because
 * nixle-releases.ts mints alert-typed posts too and a sheriff's release about
 * a wind-downed line or a rain closure is real news. Same join the brief uses
 * in dropAlertPostsShownAsActive.
 */
function isRoutineWeatherAlert(
	post: Pick<PostRow, "post_type" | "slug">,
	title: string,
): boolean {
	if (post.post_type !== "alert") return false;
	if (alertPostSlugHashOf(post.slug) === null) return false;
	return !CONSEQUENTIAL_WEATHER_RE.test(title);
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
		// "Last week" means what happened, not what was written about. A
		// preview published last Friday for an event two weeks out is neither
		// last week's news nor next week's schedule, and the W38 draft recapped
		// a September 26 celebration as though it had already happened. If the
		// event is close enough to matter the week-ahead segment picks it up
		// from the calendar; further out, it waits for the episode that covers
		// the week it lands in.
		if (row.meeting_date && row.meeting_date >= mondayDate) continue;
		const day = localMeetingDate(row.published_at);
		if (day === null || day < weekStart || day >= mondayDate) continue;
		const parsed = parsePostFile(
			readFileSync(join(ROOT, row.file_path), "utf8"),
		);
		const title = parsed.title || row.slug;
		// After the file read, because the title lives in the frontmatter and
		// PostRow does not carry it.
		if (isRoutineWeatherAlert(row, title)) continue;
		posts.push({
			slug: row.slug,
			title,
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
	const calendar = queryItems(db, {
		sourceKeys: CALENDAR_SOURCES,
		itemTypes: ["event"],
	});
	const standing = standingProgramTitles(calendar, mondayDate);
	const events = dedupeEvents(
		railEntries(
			selectUpcomingEvents(
				calendar,
				pacificDay(laDatePlusDays(mondayDate, -1)),
				7,
			),
			(url) => url,
		).filter((e) => !standing.has(normalizeTitle(e.title))),
	);

	return { posts, events };
}
