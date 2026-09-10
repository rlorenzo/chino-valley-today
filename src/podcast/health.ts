// Monday watchdog for the weekly podcast, run by cvt-podcast-watch.timer at
// 14:00 Pacific — ninety minutes after the last of the episode timer's three
// firings (06:30, 09:30, 12:30).
//
// Same loop-closer as src/pipeline/brief-health.ts: a static site cannot expire
// its own /health page, so when this week's episode has not published, the
// LIVE health file is rewritten so the keyword monitor (alerting on the absence
// of "pipeline=fresh") fires. Both `podcast=fresh` and `pipeline=fresh` are
// flipped: the podcast token says what is wrong, the pipeline token is the one
// the existing monitor watches, and a second monitor for a weekly show is not
// worth a second alarm to maintain. The next site rebuild re-stamps both.
//
// Usage: node src/podcast/health.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Db, openDb } from "../db/index.ts";
import { staleHealthText } from "../pipeline/brief-health.ts";
import { getPost, normalizeSlug } from "../pipeline/posts.ts";
import { isoWeekOf, localMeetingDate } from "../tiera/util.ts";
import { laDatePlusDays, pacificDay } from "./inputs.ts";

/**
 * The episode a healthy site is showing right now.
 *
 * The most recent Monday's week — except on Monday itself before 14:00
 * Pacific, when the episode is still allowed to be in progress and last
 * week's is the one that must exist. Mirrors expectedPodcastSlug in
 * site/src/lib/record.ts; the two must agree or the watchdog and the health
 * page would disagree about what "fresh" means.
 */
export function expectedPodcastSlug(now: Date): string {
	const today = localMeetingDate(now.toISOString());
	if (!today) throw new Error(`unusable date: ${now}`);
	const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
	const hourPacific = Number(
		new Intl.DateTimeFormat("en-US", {
			timeZone: "America/Los_Angeles",
			hour: "numeric",
			hour12: false,
		}).format(now),
	);
	const back = dow === 0 && hourPacific < 14 ? 7 : dow;
	return normalizeSlug(
		`${isoWeekOf(pacificDay(laDatePlusDays(today, -back)))}-podcast`,
	);
}

/** The rewritten health text with both freshness tokens flipped, or null. */
export function stalePodcastHealthText(health: string): string | null {
	const flippedPodcast = health.replace("podcast=fresh", "podcast=stale");
	const flipped = staleHealthText(flippedPodcast) ?? flippedPodcast;
	return flipped === health ? null : flipped;
}

export function checkPodcastDatabase(
	db: Db,
	now: Date,
): { ok: boolean; status: string; slug: string; heldReason: string | null } {
	const slug = expectedPodcastSlug(now);
	const row = getPost(db, slug);
	return {
		ok: row?.status === "published",
		status: row ? row.status : "absent",
		slug,
		heldReason: row?.held_reason ?? null,
	};
}

function main(): void {
	const { ok, status, slug, heldReason } = checkPodcastDatabase(
		openDb(),
		new Date(),
	);
	if (ok) {
		console.log(`ok: ${slug} is published; health page left as built.`);
		return;
	}
	const webRoot = process.env.CVT_WEB_ROOT ?? "/var/www/chinovalley.today";
	const healthPath = join(webRoot, "current", "health");
	console.error(
		`MISSING: ${slug} is ${status}${heldReason ? ` (${heldReason})` : ""} — marking ${healthPath} stale`,
	);
	try {
		const flipped = stalePodcastHealthText(readFileSync(healthPath, "utf8"));
		if (flipped === null) {
			console.error("  no fresh marker present; nothing to rewrite");
		} else {
			writeFileSync(healthPath, flipped);
			console.error("  wrote podcast=stale and pipeline=stale");
		}
	} catch (err) {
		console.error(`  could not rewrite the health file: ${String(err)}`);
	}
	process.exitCode = 1;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
