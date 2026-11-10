// Where the weekly meeting-recap pass stands, as three counts the site's
// /health page stamps at build time, so a reminder that can read /health (and
// nothing else on the droplet) can say what Friday's pass will find.
//
// The counts apply the meeting-recaps skill's own step 3 rule, so the page and
// the skill never disagree about what "ready" means:
//
//   ready    a target in the window with a record of what happened (transcript
//            segments, votes or minutes) and no recap post in ANY status. A
//            rejected recap counts as decided, not ready.
//   waiting  the same, but agenda-only: nothing yet says what happened, so it
//            is not recappable until a transcript, votes or minutes land.
//   held     every meeting_recap post sitting in status 'held', whatever its
//            age, because a held draft waits on a person until one decides.
//
// Counts only. No titles, bodies or slugs reach the page.
//
// One honest limit: transcripts reach the droplet only through the skill's
// manual pull (YouTube and Swagit block its IP). Before Friday's pull, a meeting
// whose only record is a transcript reads as waiting, not ready.
import type { Db } from "../db/index.ts";
import { localMeetingDate } from "../tiera/util.ts";
import { listRecapTargets, recapSlug } from "./bundle.ts";

// The skill's default window. Older targets need Rex to ask for a backfill.
const RECAP_WINDOW_DAYS = 45;

export function recapStatus(
	db: Pick<Db, "raw">,
	now: Date = new Date(),
): { ready: number; held: number; waiting: number } {
	const today = localMeetingDate(now.toISOString()) as string;
	const since = new Date(`${today}T00:00:00Z`);
	since.setUTCDate(since.getUTCDate() - RECAP_WINDOW_DAYS);

	const recapRows = db.raw
		.prepare(`SELECT slug, status FROM posts WHERE post_type = 'meeting_recap'`)
		.all() as unknown as Array<{ slug: string; status: string }>;
	const recapped = new Set(recapRows.map((r) => r.slug));
	const held = recapRows.filter((r) => r.status === "held").length;

	let ready = 0;
	let waiting = 0;
	for (const t of listRecapTargets(db, {
		since: since.toISOString().slice(0, 10),
	})) {
		// An agenda for a meeting that has not happened yet is not late.
		if (t.meetingDate > today) continue;
		if (recapped.has(recapSlug(t.bodyName, t.meetingDate))) continue;
		const { transcriptSegments, votes, minutesItems } = t.counts;
		if (transcriptSegments > 0 || votes > 0 || minutesItems > 0) ready++;
		else waiting++;
	}
	return { ready, held, waiting };
}
