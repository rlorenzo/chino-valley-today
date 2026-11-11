// Writes content/creators/{creators,videos}.json, the data behind /creators/.
// Called by the dashboard after every change; the site is rebuilt on the host
// each morning after the brief (scripts/run-brief.sh), and push-posts.sh
// commits these files with the published posts.
//
// Both are whole-file rewrites, not one file per entry: push-posts.sh stages
// with --ignore-removal, so a deleted per-video file would never leave git, and
// a removal is exactly the change that has to reach the record.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Db, openDb } from "../db/index.ts";
import { ROOT } from "../store.ts";
import { listCreatorPosts, listCreators } from "./store.ts";
import { profileUrl } from "./tiktok.ts";

export const CREATORS_DIR = join(ROOT, "content", "creators");

// /creators/ shows the most recent of these; older ones stay in the database.
const MAX_VIDEOS = 60;

export interface CreatorProfileEntry {
	id: string; // the handle; Astro's file() loader keys entries by id
	platform: "tiktok";
	handle: string;
	display_name: string;
	covers: string | null;
	profile_url: string;
}

export interface CreatorVideoEntry {
	id: string; // the video id
	platform: "tiktok";
	video_id: string;
	url: string;
	handle: string;
	display_name: string;
	profile_url: string;
	description: string;
	published_at: string;
}

export function creatorsExport(db: Db): {
	creators: CreatorProfileEntry[];
	videos: CreatorVideoEntry[];
} {
	// Only creators who said yes get a profile. A post can be featured without
	// asking (a link to a public post, EDITORIAL.md), but a profile is a
	// standing endorsement and needs the creator's agreement.
	const creators = listCreators(db)
		.filter((c) => c.consent_at)
		.map((c) => ({
			id: c.handle,
			platform: c.platform,
			handle: c.handle,
			display_name: c.display_name,
			covers: c.covers,
			profile_url: profileUrl(c.handle),
		}));
	const videos = listCreatorPosts(db, "published")
		.slice(0, MAX_VIDEOS)
		.map((p) => ({
			id: p.video_id,
			platform: p.platform,
			video_id: p.video_id,
			url: p.url,
			handle: p.handle,
			display_name: p.display_name,
			profile_url: profileUrl(p.handle),
			description: p.description,
			published_at: p.published_at ?? p.added_at,
		}));
	return { creators, videos };
}

function writeJsonAtomic(path: string, value: unknown): void {
	// Renamed into place, so a failed write cannot leave truncated JSON that
	// breaks the site build.
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`);
	renameSync(temp, path);
}

/**
 * Takes the given videos out of one brief's text: their cards in the body
 * (the markup renderCreatorVideoCards in src/pipeline/daily-brief.ts wrote),
 * the section heading once no card is left, and their creator_videos
 * frontmatter entries (renderPostFile in src/pipeline/posts.ts).
 */
export function scrubBriefText(text: string, removed: Set<string>): string {
	return text
		.replace(
			/ {2}<li class="creator-video">\n[\s\S]*?\n {2}<\/li>\n/g,
			(card) => {
				const id = /data-tiktok-play="(\d+)"/.exec(card)?.[1];
				return id && removed.has(id) ? "" : card;
			},
		)
		.replace(
			/## From local creators\n\n<ul class="creator-videos__list">\n<\/ul>\n*/,
			"",
		)
		.replace(/ {2}- video_id: "(\d+)"\n(?: {4}.*\n)*/g, (entry, id) =>
			removed.has(id) ? "" : entry,
		)
		.replace(/^creator_videos:\n(?! {2}- )/m, "");
}

/**
 * A brief bakes its creator cards into its own file, so taking a post down has
 * to reach the briefs that already carried it, not only /creators/. Scrubs
 * every video the database marks removed; returns how many briefs changed.
 */
export function scrubBriefs(db: Db, publishedDir: string): number {
	if (!existsSync(publishedDir)) return 0;
	const removed = new Set(
		(
			db.raw
				.prepare(`SELECT video_id FROM creator_posts WHERE status = 'removed'`)
				.all() as unknown as { video_id: string }[]
		).map((r) => r.video_id),
	);
	if (removed.size === 0) return 0;
	let changed = 0;
	for (const name of readdirSync(publishedDir)) {
		if (!name.endsWith("-daily-brief.md")) continue;
		const path = join(publishedDir, name);
		const before = readFileSync(path, "utf8");
		const after = scrubBriefText(before, removed);
		if (after === before) continue;
		writeFileSync(`${path}.tmp`, after);
		renameSync(`${path}.tmp`, path);
		changed++;
	}
	return changed;
}

/**
 * Writes the /creators/ data and scrubs removed videos from published briefs.
 * The briefs are the sibling `published` directory, so a test's temp dir has
 * none to touch.
 */
export function writeCreatorsFiles(db: Db, dir: string = CREATORS_DIR): void {
	const { creators, videos } = creatorsExport(db);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "creators.json"), creators);
	writeJsonAtomic(join(dir, "videos.json"), videos);
	scrubBriefs(db, join(dir, "..", "published"));
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const db = openDb();
	// An empty creators table means a database rebuilt or restored from before
	// this feature, not "everyone was removed" (removal keeps the row). Writing
	// [] over the committed files would take every post off the site.
	const { n } = db.raw
		.prepare(`SELECT COUNT(*) AS n FROM creators`)
		.get() as unknown as { n: number };
	if (n === 0) {
		console.log(
			"creators: no creators in the database, files left as they are",
		);
	} else {
		writeCreatorsFiles(db);
		console.log(`creators: wrote ${CREATORS_DIR}`);
	}
}
