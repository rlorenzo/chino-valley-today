// Phase 1, Tier A: deterministic template rendering of structured data.
// Zero LLM calls. Reads the CURRENT database (does not run scrapers),
// generates posts for the four Tier A post types, and — because Tier A
// requires no human review — transitions each straight to 'published'.
//
// Idempotent: createPost() (src/pipeline/posts.ts) updates a still-queued
// post in place ('updated') and refuses to touch a post that has already
// been published or rejected ('skipped'); slugs are stable across re-runs
// (see each generator for its slug scheme), so re-running this script never
// creates a duplicate post for the same real-world meeting/alert/week.
//
// Usage: node src/tiera/run.ts
import { openDb } from "../db/index.ts";
import { createPost, type NewPost, transitionPost } from "../pipeline/posts.ts";
import { generateAlerts } from "./alerts.ts";
import { generateBusinessTracker } from "./business-tracker.ts";
import { generateMeetingPreviews } from "./meeting-previews.ts";
import { generateNewsDigest } from "./news-digest.ts";
import { generateNixleReleases } from "./nixle-releases.ts";

interface Generator {
	label: string;
	run: () => { posts: NewPost[]; notes: string[] };
}

function main(): void {
	const db = openDb();
	const now = new Date();
	console.log(`Tier A run started at ${now.toISOString()}`);

	const generators: Generator[] = [
		{ label: "meeting_preview", run: () => generateMeetingPreviews(db, now) },
		{ label: "alert", run: () => generateAlerts(db, now) },
		{ label: "nixle_release", run: () => generateNixleReleases(db, now) },
		{ label: "business_tracker", run: () => generateBusinessTracker(db, now) },
		{ label: "news_digest", run: () => generateNewsDigest(db, now) },
	];

	const seenSlugs = new Set<string>();
	const totals: Record<
		string,
		{ created: number; updated: number; skipped: number }
	> = {};
	let anyPosts = 0;

	for (const gen of generators) {
		console.log(`\n=== ${gen.label} ===`);
		const { posts, notes } = gen.run();
		for (const note of notes) console.log(`  note: ${note}`);

		totals[gen.label] = { created: 0, updated: 0, skipped: 0 };
		for (const post of posts) {
			if (seenSlugs.has(post.slug)) {
				console.error(
					`  ERROR: slug collision within this run, refusing to overwrite: ${post.slug}`,
				);
				continue;
			}
			seenSlugs.add(post.slug);
			anyPosts++;

			const { outcome } = createPost(db, post);
			// A generator that set heldReason has decided this post needs a human
			// before it can go out (Tier C content, EDITORIAL.md). Route it to the
			// held queue the dashboard already reads, rather than publishing it —
			// and rather than dropping it, which is what skipping it amounts to.
			const target = post.heldReason ? "held" : "published";
			if (outcome !== "skipped") {
				transitionPost(db, post.slug, target, {
					heldReason: post.heldReason,
				});
			}
			totals[gen.label][outcome]++;
			console.log(
				`  ${post.slug}: ${outcome}${outcome !== "skipped" ? ` -> ${target}` : ""}`,
			);
		}
		if (posts.length === 0) console.log("  (no posts generated)");
	}

	console.log("\n=== summary ===");
	for (const [label, counts] of Object.entries(totals)) {
		console.log(
			`  ${label}: created=${counts.created} updated=${counts.updated} skipped=${counts.skipped}`,
		);
	}
	if (anyPosts === 0)
		console.log("  (no posts generated this run across any post type)");

	const dupes = db.raw
		.prepare("SELECT slug, COUNT(*) c FROM posts GROUP BY slug HAVING c > 1")
		.all() as Array<{
		slug: string;
		c: number;
	}>;
	if (dupes.length > 0) {
		console.error(
			"\nDUPLICATE SLUGS DETECTED (should be impossible — posts.slug is UNIQUE):",
			dupes,
		);
		process.exitCode = 1;
	}
}

main();
