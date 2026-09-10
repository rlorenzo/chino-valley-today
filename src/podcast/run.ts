// Weekly two-host podcast: "Chino Valley Today, the Week in Review".
//
//   node src/podcast/run.ts                  the most recent Monday, Pacific
//   node src/podcast/run.ts --date=2026-09-07
//
// Runs Mondays. The timer fires more than once, so every path below either
// does the work or exits 0 having decided not to: a published or rejected
// episode is never regenerated, and an episode held because the RENDER failed
// resumes from the draft already on disk rather than paying for a second
// generation of a script that already passed both gates.
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
	transitionPost,
} from "../pipeline/posts.ts";
import { ROOT } from "../store.ts";
import {
	humanDateFromLocal,
	isoWeekOf,
	localMeetingDate,
} from "../tiera/util.ts";
import { renderEpisode } from "./audio.ts";
import { laDatePlusDays, pacificDay, podcastInputs } from "./inputs.ts";
import {
	buildPodcastBundle,
	composeTranscript,
	PODCAST_REPAIR_GUIDANCE,
	PODCAST_SYSTEM,
	podcastChecks,
	podcastPromptBody,
} from "./script.ts";

// An episode with almost nothing to review is not an episode. Three stories is
// the floor at which "the week in review" is an honest description.
const MIN_POSTS = 3;

/** The episode's Monday: `--date=` if given, else the most recent one. */
function episodeMonday(argv: string[]): string {
	const flag = argv
		.find((a) => a.startsWith("--date="))
		?.slice("--date=".length);
	if (flag) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(flag))
			throw new Error(`--date must be YYYY-MM-DD, got ${flag}`);
		return flag;
	}
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

const mondayDate = episodeMonday(process.argv.slice(2));
const monday = pacificDay(mondayDate);
// Normalized here, not only inside createPost: the renderer names the audio
// files and mints their URLs from this string, and the site builds the
// chapters URL from the post's lowercase id. On a case-sensitive host an
// uppercase W here is a 404 in the feed.
const slug = normalizeSlug(`${isoWeekOf(monday)}-podcast`);
const title = `Week in Review: ${humanDateFromLocal(mondayDate)}`;
const db = openDb();

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
	// The script already passed Gate 1 and Gate 2. Only the render failed, so
	// this retries the render and nothing else.
	console.log(`  held on the render (${existing.held_reason}); retrying it.`);
	const { draft, sources } = heldDraft(existing.file_path);
	const extra = await withAudio(draft);
	createPost(db, {
		slug,
		postType: "podcast",
		tier: "B",
		title,
		bodyMd: draft,
		sources,
		sourceKeys: ["podcast"],
		...extra,
	});
	transitionPost(db, slug, "published");
	console.log(`  PUBLISHED -> content/published/${slug.toLowerCase()}.md`);
	process.exit(0);
}

const inputs = podcastInputs(db, monday);
console.log(
	`  inputs: ${inputs.posts.length} post(s) last week, ${inputs.events.length} event(s) ahead`,
);
if (inputs.posts.length < MIN_POSTS) {
	console.log(`skip: ${inputs.posts.length} posts`);
	process.exit(0);
}

const bundle = buildPodcastBundle(inputs, monday);
console.log(
	`  bundle ${bundle.targetKey}: ${bundle.allowedUrls.length} citable URLs`,
);

await runGatedPipeline({
	db,
	bundle,
	promptBody: podcastPromptBody(inputs, monday),
	generatorSystem: PODCAST_SYSTEM,
	slug,
	title,
	postType: "podcast",
	tier: "B",
	meetingDate: mondayDate,
	repairGuidance: PODCAST_REPAIR_GUIDANCE,
	extraChecks: podcastChecks,
	beforePublish: withAudio,
});
