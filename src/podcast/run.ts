// Weekly two-host podcast: "Chino Valley Today, the Week in Review".
//
//   node src/podcast/run.ts                  the most recent Monday, Pacific
//   node src/podcast/run.ts --date=2026-09-07
//
// Runs Mondays. The timer fires more than once, so every path below either
// does the work or exits 0 having decided not to: a published or rejected
// episode is never regenerated, and an episode held for audio — the render
// failed, or a human approved it in the dashboard — resumes from the draft
// already on disk rather than paying for a second generation of a script that
// already passed both gates. That hand-off is drained by week, not by today's
// date, so an approval on any day of the week still lands.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePostFile } from "../admin/render.ts";
import { openDb } from "../db/index.ts";
import { runGatedPipeline } from "../pipeline/gate-run.ts";
import {
	createPost,
	getPost,
	type NewPost,
	normalizeSlug,
	TIER_C_ACK,
	transitionPost,
} from "../pipeline/posts.ts";
import { ROOT } from "../store.ts";
import {
	humanDateFromLocal,
	isoWeekOf,
	localMeetingDate,
} from "../tiera/util.ts";
import { publishEpisodeAudio, renderEpisode } from "./audio.ts";
import {
	laDatePlusDays,
	pacificDay,
	pendingAudioEpisode,
	podcastInputs,
} from "./inputs.ts";
import {
	buildPodcastBundle,
	composeTranscript,
	podcastChecks,
	podcastPromptBody,
	podcastRepairGuidance,
	podcastSystem,
	WORDS_MIN,
} from "./script.ts";

// A quiet week is a short episode, not a missing one. One published story is
// a show — segment one is a single story and the weight sits in the week
// ahead — so the floor is a story, not three.
//
// The spoken-length floor moves with the material for the same reason. A week
// carrying one story and ten listings cannot honestly reach the full-week
// floor, and forcing it to is how invented detail gets in — "DUI saturation
// patrols" was a generator padding a headline with no body behind it. A full
// week keeps script.ts's own WORDS_MIN rather than restating the number here.
const FULL_WEEK_POSTS = 3;
// 150 is measured, not guessed: on W38 — one published story and thirteen
// listings after curation — the generator wrote 203 to 246 spoken words, and
// repair, which on a thin week may cut a claim without replacing it, took one
// run to 173. A floor the material cannot reach produces no episode, not a
// longer one. 150 still catches a stub; the structural checks catch a
// malformed one.
const THIN_WEEK_MIN_WORDS = 150;

/** The Monday named by `--date=`, or null if the flag was not passed. */
function dateFlag(argv: string[]): string | null {
	const flag = argv
		.find((a) => a.startsWith("--date="))
		?.slice("--date=".length);
	if (!flag) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(flag))
		throw new Error(`--date must be YYYY-MM-DD, got ${flag}`);
	return flag;
}

/** The most recent Monday, Pacific. */
function mostRecentMonday(): string {
	const today = localMeetingDate(new Date().toISOString());
	if (!today) throw new Error("could not read today's Pacific date");
	// Day-of-week off the UTC fields of a date-only string, which parse as UTC
	// midnight and so name their own weekday.
	const mondayOffset = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
	return laDatePlusDays(today, -mondayOffset);
}

const DISCLOSURE_MARK = "*Generated from public records";

/**
 * The draft back out of a held episode's file: frontmatter off, and the
 * disclosure footer renderPostFile appended off too, or re-filing the post
 * would append a second one.
 */
function heldDraft(filePath: string): { draft: string; sources: string[] } {
	const parsed = parsePostFile(readFileSync(join(ROOT, filePath), "utf8"));
	const cut = parsed.body.lastIndexOf("\n\n---\n\n");
	const draft =
		cut !== -1 && parsed.body.slice(cut).includes(DISCLOSURE_MARK)
			? parsed.body.slice(0, cut)
			: parsed.body;
	return { draft: draft.trim(), sources: parsed.sources };
}

const db = openDb();

// Drain the audio backlog before starting a new week, so an episode approved
// on any day still lands (see pendingAudioEpisode). An explicit --date= names
// its own week and wins over the backlog.
const flagDate = dateFlag(process.argv.slice(2));
const mondayDate =
	flagDate ?? pendingAudioEpisode(db)?.meeting_date ?? mostRecentMonday();
const monday = pacificDay(mondayDate);
// Normalized here, not only inside createPost: the renderer names the audio
// files and mints their URLs from this string, and the site builds the
// chapters URL from the post's lowercase id. On a case-sensitive host an
// uppercase W here is a 404 in the feed.
const slug = normalizeSlug(`${isoWeekOf(monday)}-podcast`);
const title = `Week in Review: ${humanDateFromLocal(mondayDate)}`;

console.log(`Podcast ${slug} — week of ${mondayDate}`);

const existing = getPost(db, slug);
if (existing?.status === "published" || existing?.status === "rejected") {
	console.log(`  already ${existing.status}; nothing to do.`);
	process.exit(0);
}

// beforePublish is where the episode becomes audio. It runs after both gates,
// so a throw here holds a script that is otherwise fit to publish — which is
// why the resume path below exists.
async function withAudio(draftMd: string): Promise<Partial<NewPost>> {
	const transcriptMd = composeTranscript(draftMd, monday);
	console.log(
		`  rendering audio (${transcriptMd.length} chars of transcript)...`,
	);
	const audio = await renderEpisode({ slug, transcriptMd, title });
	console.log(
		`  audio: ${audio.url} (${audio.bytes} bytes, ${audio.durationSec}s)`,
	);
	return { bodyMd: transcriptMd, audio };
}

if (existing?.status === "held" && existing.held_reason?.startsWith("audio:")) {
	// Two ways in: the render failed on its own, or a human approved the held
	// episode in the dashboard. Either way the script already passed Gate 1
	// and Gate 2, so this resumes from the draft on disk and renders — nothing
	// is regenerated. Only the audit trail differs.
	const humanApproved = existing.held_reason.startsWith("audio:approved");
	console.log(
		humanApproved
			? "  approved in the dashboard; composing and rendering it."
			: `  held on the render (${existing.held_reason}); retrying it.`,
	);
	const { draft, sources } = heldDraft(existing.file_path);
	const extra = await withAudio(draft);
	const written = createPost(db, {
		slug,
		postType: "podcast",
		// The row's tier, not a hardcoded "B": createPost UPDATEs an existing
		// row's tier, and the judge may have escalated this episode to C — the
		// classification the Tier C acknowledgment rule hangs on.
		tier: existing.tier,
		title,
		bodyMd: draft,
		sources,
		sourceKeys: ["podcast"],
		// Without this createPost's UPDATE nulls meeting_date, the only column
		// naming the week this episode covers — and what the resume lookup
		// above reads to find it again.
		meetingDate: mondayDate,
		...extra,
	});
	// Rendering takes minutes, and the Reject button stays live the whole time.
	// createPost refuses to touch a rejected or already-published row, so a
	// "skipped" here means a human decided while the audio was being made:
	// honor that decision rather than publishing over the top of it.
	if (written.outcome === "skipped") {
		console.log(
			`  ${getPost(db, slug)?.status ?? "gone"} while rendering; not publishing.`,
		);
		// The render's output stays in the private cache, never promoted: an
		// episode nobody published must not be reachable at /audio/<slug>.mp3.
		process.exit(0);
	}
	publishEpisodeAudio(slug);
	transitionPost(
		db,
		slug,
		"published",
		humanApproved
			? {
					publishedVia: "manual",
					// The acknowledgment marker is derived, not dropped: approve
					// refuses a Tier C post without the ticked box, so a
					// human-approved Tier C row is proof the operator ticked it.
					heldReason: `reviewed:approved${existing.tier === "C" ? TIER_C_ACK : ""} (audio rendered)`,
				}
			: {},
	);
	console.log(`  PUBLISHED -> content/published/${slug.toLowerCase()}.md`);
	process.exit(0);
}

const inputs = podcastInputs(db, monday);
console.log(
	`  inputs: ${inputs.posts.length} post(s) last week, ${inputs.events.length} event(s) ahead`,
);
// One story is enough; zero is not. "## Last week" is a required section and
// every turn in it needs a citation from the bundle, so a week with no posts
// has nothing that can honestly fill it — an episode generated from listings
// alone either fails the section check or narrates the week ahead twice.
if (inputs.posts.length === 0) {
	console.log(
		`skip: nothing published last week (${inputs.events.length} event(s) ahead)`,
	);
	process.exit(0);
}
const thinWeek = inputs.posts.length < FULL_WEEK_POSTS;
const minWords = thinWeek ? THIN_WEEK_MIN_WORDS : WORDS_MIN;
if (thinWeek)
	console.log(`  thin week: spoken-length floor lowered to ${minWords} words`);

const bundle = buildPodcastBundle(inputs, monday);
console.log(
	`  bundle ${bundle.targetKey}: ${bundle.allowedUrls.length} citable URLs`,
);

await runGatedPipeline({
	db,
	bundle,
	promptBody: podcastPromptBody(inputs, monday),
	generatorSystem: podcastSystem(minWords),
	slug,
	title,
	postType: "podcast",
	tier: "B",
	meetingDate: mondayDate,
	repairGuidance: podcastRepairGuidance(minWords),
	extraChecks: (draftMd: string) => podcastChecks(draftMd, minWords),
	beforePublish: withAudio,
	afterPublish: () => publishEpisodeAudio(slug),
});
