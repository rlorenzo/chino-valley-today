// Backfill `topics:` frontmatter into already-published posts.
//
// Published posts are otherwise immutable: createPost() refuses to write over a
// file in content/published/, a guard added after 2026-08-18, when a Tier A run
// overwrote three published previews and stripped their dated correction notes.
// That guard is deliberately left alone. This script is the other half of the
// answer — a rewrite path a human runs on purpose, so the 05:50 generator still
// cannot clobber a post by accident while the corpus can still be migrated when
// a format changes.
//
// Two limits keep it inside what was actually decided:
//   1. It only ever adds or replaces the `topics:` block. Every other
//      frontmatter line, and the entire body, is copied through byte for byte
//      and verified to be unchanged before the file is written.
//   2. It therefore cannot touch a published claim. EDITORIAL.md's corrections
//      rule stands untouched: a substantive correction is still a visible,
//      dated note, never a silent edit.
//
// Usage:
//   node scripts/backfill-post-topics.ts            # dry run; prints the plan
//   node scripts/backfill-post-topics.ts --write    # apply it
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTopics, type TopicSlug } from "../src/pipeline/topics.ts";
import { ROOT } from "../src/store.ts";

const PUBLISHED_DIR = join(ROOT, "content", "published");

interface ParsedPost {
	/** Frontmatter lines, without the enclosing `---` delimiters. */
	frontmatter: string[];
	/** Everything after the closing delimiter, verbatim. */
	body: string;
}

/**
 * Splits a post file into frontmatter and body.
 *
 * Requires a well-formed, closed frontmatter block. Splitting on `---` and
 * taking part [1] hands back the whole body when the closing delimiter is
 * missing, which here would mean classifying a post from its prose and then
 * writing the result back — so a malformed file is skipped loudly instead.
 */
function parsePost(text: string): ParsedPost | null {
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---\n", 3);
	if (end === -1) return null;
	return {
		frontmatter: text
			.slice(4, end + 1)
			.split("\n")
			.slice(0, -1),
		body: text.slice(end + 5),
	};
}

/** Undoes the JSON-string quoting renderPostFile() applies via its `y()` helper. */
function unquote(raw: string): string {
	if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2))
		return raw;
	return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Reads a scalar frontmatter value, unquoting it the way the renderer quotes. */
function scalar(frontmatter: string[], key: string): string | undefined {
	const line = frontmatter.find((l) => l.startsWith(`${key}: `));
	if (!line) return undefined;
	return unquote(line.slice(key.length + 2).trim());
}

/** Reads a list-valued frontmatter key (`key:` then `  - value` lines). */
function list(frontmatter: string[], key: string): string[] {
	const start = frontmatter.indexOf(`${key}:`);
	if (start === -1) return [];
	const out: string[] = [];
	for (const line of frontmatter.slice(start + 1)) {
		if (!line.startsWith("  - ")) break;
		out.push(unquote(line.slice(4).trim()));
	}
	return out;
}

/** Frontmatter with any existing `topics:` block removed. */
function withoutTopics(frontmatter: string[]): string[] {
	const start = frontmatter.indexOf("topics:");
	if (start === -1) return [...frontmatter];
	let end = start + 1;
	while (end < frontmatter.length && frontmatter[end].startsWith("  - ")) end++;
	return [...frontmatter.slice(0, start), ...frontmatter.slice(end)];
}

/**
 * Re-emits the file with `topics:` last in the frontmatter, matching where
 * renderPostFile() writes it so a backfilled post and a freshly generated one
 * are byte-identical in shape.
 */
function render(parsed: ParsedPost, topics: TopicSlug[]): string {
	const lines = withoutTopics(parsed.frontmatter);
	if (topics.length) lines.push("topics:", ...topics.map((t) => `  - ${t}`));
	return `---\n${lines.join("\n")}\n---\n${parsed.body}`;
}

/**
 * Thrown when a rewrite would alter anything but the `topics:` block. Distinct
 * from a plain Error so the caller can tell "this file is unreadable, skip it"
 * from "this file would be corrupted, stop the run".
 */
export class CorruptionRisk extends Error {}

/** What backfilling one post would do. `next === null` means nothing to change. */
export interface Plan {
	/** Topics already in the file. */
	from: string[];
	/** Topics classification says belong there. */
	to: TopicSlug[];
	/** The rewritten file, or null when it would be identical. */
	next: string | null;
}

/**
 * Plans one post's backfill, or explains why it cannot be planned.
 *
 * Pure, so the invariant below is testable without touching the corpus: this
 * may change the `topics:` block and nothing else. That is verified against the
 * re-parsed output rather than trusted from the code that produced it, and a
 * violation throws rather than returning, because a silent body edit to a
 * published post is exactly what EDITORIAL.md's corrections rule forbids.
 */
export function planBackfill(text: string): Plan {
	const parsed = parsePost(text);
	if (!parsed) throw new Error("no well-formed frontmatter block");

	const postType = scalar(parsed.frontmatter, "post_type");
	if (!postType) throw new Error("no post_type");

	const to = classifyTopics({
		postType,
		title: scalar(parsed.frontmatter, "title"),
		sources: list(parsed.frontmatter, "sources"),
	});
	const from = list(parsed.frontmatter, "topics");
	if (from.length === to.length && from.every((t, i) => t === to[i])) {
		return { from, to, next: null };
	}

	const next = render(parsed, to);
	const reparsed = parsePost(next);
	if (!reparsed || reparsed.body !== parsed.body) {
		throw new CorruptionRisk("body would change");
	}
	const before = withoutTopics(parsed.frontmatter).join("\n");
	const after = withoutTopics(reparsed.frontmatter).join("\n");
	if (before !== after) {
		throw new CorruptionRisk("frontmatter outside `topics:` would change");
	}
	return { from, to, next };
}

function main(): void {
	const write = process.argv.includes("--write");
	const files = readdirSync(PUBLISHED_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort();

	let changed = 0;
	let skipped = 0;

	for (const file of files) {
		const path = join(PUBLISHED_DIR, file);
		let plan: Plan;
		try {
			plan = planBackfill(readFileSync(path, "utf8"));
		} catch (err) {
			// A file that cannot be read is skipped; one that would be corrupted
			// stops the whole run, because the next file is no safer.
			const reason = err instanceof Error ? err.message : String(err);
			if (err instanceof CorruptionRisk) {
				console.error(`ABORT ${file} — ${reason}; refusing to write`);
				process.exitCode = 1;
				return;
			}
			console.error(`SKIP  ${file} — ${reason}`);
			skipped++;
			continue;
		}
		if (plan.next === null) continue;

		const from = plan.from.length ? plan.from.join(", ") : "(none)";
		const to = plan.to.length ? plan.to.join(", ") : "(none)";
		console.log(`${write ? "WRITE" : "PLAN "} ${file}: ${from} -> ${to}`);
		if (write) writeFileSync(path, plan.next);
		changed++;
	}

	console.log(
		`\n${files.length} published post(s); ${changed} to change, ${skipped} skipped.`,
	);
	if (!write && changed > 0) console.log("Dry run. Re-run with --write.");
}

// Guarded so the pure planner above can be imported by tests without the script
// walking content/published/ as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) main();
