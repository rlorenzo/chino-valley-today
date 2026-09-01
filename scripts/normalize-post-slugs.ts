// One-off migration: lowercase every post slug that still carries an uppercase
// letter, on disk and in the database.
//
// Why it exists. A post's public URL is not its stored slug. The site reads
// content/ with Astro's glob loader, which derives a collection id by
// lowercasing the filename, and routes /posts/<id>/. Every ISO-week slug —
// 2026-W36-news-digest, 2026-W33-business-tracker — therefore published at an
// address the pipeline never recorded, and the daily brief, which links posts
// by their stored slug, linked to a 404 whose empty body reads as a blank page.
//
// createPost() now normalizes, so nothing NEW can drift. This is the other
// half: the rows and files written before it did. Run it once per database.
//
// It only renames. Frontmatter and body are copied byte for byte — the file is
// moved, never rewritten — so EDITORIAL.md's corrections rule is untouched: no
// published claim changes, and the post keeps the URL it has always had (Astro
// was already serving these at their lowercased address, which is the whole
// bug). A published post's own URL is therefore stable across this migration.
//
// Usage:
//   node scripts/normalize-post-slugs.ts            # dry run; prints the plan
//   node scripts/normalize-post-slugs.ts --write    # apply it
import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { normalizeSlug } from "../src/pipeline/posts.ts";
import { ROOT } from "../src/store.ts";

interface Row {
	id: number;
	slug: string;
	file_path: string;
}

export interface Plan {
	id: number;
	from: string;
	to: string;
	fromPath: string;
	toPath: string;
	/** Set when the move cannot be made safely; the row is left alone. */
	blocked?: string;
}

/**
 * Builds the rename plan. Exported so the test can drive it without a database.
 *
 * A collision — some other row already holding the lowercased slug — is
 * reported, never resolved: posts.slug is UNIQUE, and picking a winner between
 * two real posts is an editorial call, not a migration's.
 */
export function planRenames(rows: Row[]): Plan[] {
	const bySlug = new Map(rows.map((r) => [r.slug, r]));
	const plans: Plan[] = [];
	for (const row of rows) {
		const to = normalizeSlug(row.slug);
		if (to === row.slug) continue;
		const toPath = join(dirname(row.file_path), `${to}.md`);
		const plan: Plan = {
			id: row.id,
			from: row.slug,
			to,
			fromPath: row.file_path,
			toPath,
		};
		const clash = bySlug.get(to);
		if (clash && clash.id !== row.id)
			plan.blocked = `slug ${to} already belongs to post id ${clash.id}`;
		plans.push(plan);
	}
	return plans;
}

/**
 * Rewrites the TARGET of an internal /posts/ link to the address the site
 * actually serves, and nothing else.
 *
 * The briefs already published carry the dead uppercase links this migration
 * exists to stop producing — repairing the generator does not un-break a brief
 * that shipped last Monday. The pattern is deliberately tight: `](/posts/` up
 * to the closing paren, so only a markdown link destination is touched. Link
 * TEXT, prose, frontmatter and every other byte are copied through, which is
 * what keeps this a link repair rather than the silent edit of a published
 * claim that EDITORIAL.md forbids.
 */
export function normalizeBodyLinks(text: string): {
	next: string;
	count: number;
} {
	let count = 0;
	const next = text.replace(
		/\]\(\/posts\/([^)\s]+)\)/g,
		(whole, target: string) => {
			const lowered = normalizeSlug(target);
			if (lowered === target) return whole;
			count++;
			return `](/posts/${lowered})`;
		},
	);
	return { next, count };
}

/** Every markdown file under content/, in every status directory. */
function contentFiles(): string[] {
	const base = join(ROOT, "content");
	if (!existsSync(base)) return [];
	return readdirSync(base, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) =>
			readdirSync(join(base, d.name))
				.filter((f) => f.endsWith(".md"))
				.map((f) => join(base, d.name, f)),
		);
}

function repairLinks(write: boolean): number {
	let touched = 0;
	for (const abs of contentFiles()) {
		const text = readFileSync(abs, "utf8");
		const { next, count } = normalizeBodyLinks(text);
		if (count === 0) continue;
		console.log(`  ${abs.slice(ROOT.length + 1)}: ${count} link(s)`);
		if (write) writeFileSync(abs, next);
		touched++;
	}
	return touched;
}

function main(): void {
	const write = process.argv.includes("--write");
	const db = openDb();
	const rows = db.raw
		.prepare("SELECT id, slug, file_path FROM posts ORDER BY id")
		.all() as unknown as Row[];
	const plans = planRenames(rows);

	// No early return: a database can be clean while the bodies published from
	// it still carry the dead links, so the second pass below always runs.
	if (plans.length === 0)
		console.log(`No uppercase slugs among ${rows.length} post(s).`);

	let renamed = 0;
	let blocked = 0;
	for (const p of plans) {
		if (p.blocked) {
			console.error(`  BLOCKED ${p.from}: ${p.blocked}`);
			blocked++;
			continue;
		}
		const absFrom = join(ROOT, p.fromPath);
		const absTo = join(ROOT, p.toPath);
		// The file may already sit at the target name: a case-insensitive
		// filesystem (macOS) considers the two paths the same file, and a repo
		// checkout may have been renamed by hand ahead of the database.
		const fileMove = existsSync(absFrom) && absFrom !== absTo;
		console.log(
			`  ${p.from} -> ${p.to}${fileMove ? "" : existsSync(absTo) ? " (file already in place)" : " (FILE MISSING — row updated anyway)"}`,
		);
		if (!write) continue;
		if (fileMove) renameSync(absFrom, absTo);
		db.raw
			.prepare("UPDATE posts SET slug = ?, file_path = ? WHERE id = ?")
			.run(p.to, p.toPath, p.id);
		renamed++;
	}

	// Second pass: the posts ALREADY published carry the dead links this
	// migration exists to stop producing.
	console.log("\ninternal links in published bodies:");
	const relinked = repairLinks(write);
	if (relinked === 0) console.log("  (none to repair)");

	console.log(
		write
			? `\nRenamed ${renamed} post(s); repaired links in ${relinked} file(s); ${blocked} blocked.`
			: `\nDry run: ${plans.length - blocked} post(s) would be renamed, ${relinked} file(s) relinked, ${blocked} blocked. Re-run with --write to apply.`,
	);
	if (blocked > 0) process.exitCode = 1;
}

// Guarded so the pure planner above can be imported by tests without the script
// opening the live database as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) main();
