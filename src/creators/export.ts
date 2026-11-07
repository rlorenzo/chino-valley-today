// Writes content/creators/{creators,videos}.json, the data behind /creators/.
// Called by the dashboard after every change; the site is rebuilt on the host
// each morning after the brief (scripts/run-brief.sh), and push-posts.sh
// commits these files with the published posts.
//
// Both are whole-file rewrites, not one file per entry: push-posts.sh stages
// with --ignore-removal, so a deleted per-video file would never leave git, and
// a removal is exactly the change that has to reach the record.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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

export function writeCreatorsFiles(db: Db, dir: string = CREATORS_DIR): void {
	const { creators, videos } = creatorsExport(db);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "creators.json"), creators);
	writeJsonAtomic(join(dir, "videos.json"), videos);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	writeCreatorsFiles(openDb());
	console.log(`creators: wrote ${CREATORS_DIR}`);
}
