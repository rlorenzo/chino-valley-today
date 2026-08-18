// Post lifecycle: content lives as markdown+frontmatter in content/<status>/,
// state lives in the posts table. Auto and manual paths share these functions.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Db, nowIso } from "../db/index.ts";
import { ROOT } from "../store.ts";

export type PostStatus = "queued" | "held" | "published" | "rejected";
export type Tier = "A" | "B" | "C";

export interface PostRow {
	id: number;
	slug: string;
	post_type: string;
	tier: Tier;
	status: PostStatus;
	file_path: string;
	meeting_date: string | null;
	gates: string | null;
	judge: string | null;
	source_count: number | null;
	held_reason: string | null;
	published_via: "auto" | "manual" | null;
	created_at: string;
	published_at: string | null;
}

export interface NewPost {
	slug: string; // stable across re-runs; re-running a generator updates in place
	postType:
		| "meeting_preview"
		| "meeting_recap"
		| "business_tracker"
		| "alert"
		| "news_digest"
		| "daily-brief";
	tier: Tier;
	title: string;
	bodyMd: string; // markdown body; the disclosure footer is appended automatically
	meetingDate?: string;
	briefDate?: string; // daily-brief only: the LA calendar day the brief covers
	// daily-brief only: structured week-ahead calendar events, rendered by the
	// site (the index's "coming up" rail) rather than by the markdown body.
	eventsAhead?: BriefEventAhead[];
	sources: string[]; // source_urls backing every claim in the post
	// Set by a generator that has decided this post must NOT auto-publish, and
	// why. The Tier A runner routes such a post to the held queue instead of
	// publishing it, so it reaches the dashboard's existing approve/reject flow
	// rather than being silently dropped. A hold nobody can see is a drop.
	heldReason?: string;
}

export interface BriefEventAhead {
	date: string; // LA calendar day, YYYY-MM-DD
	time: string | null; // "6:00 PM" | "all day" | null when the source has none
	title: string;
	venue: string | null;
	url: string; // the event's source_url — provenance, like every claim
}

const DIR_BY_STATUS: Record<PostStatus, string> = {
	queued: join("content", "queue"),
	held: join("content", "held"),
	published: join("content", "published"),
	rejected: join("content", "rejected"),
};

const DISCLOSURE_LINE =
	"*Generated from public records with automated review; see sources linked above. Corrections: see About page.*";

const DISCLOSURE_FOOTER = `\n\n---\n\n${DISCLOSURE_LINE}\n`;

// Reader glossary for the record codes that ABC posts carry verbatim. These
// posts quote source records literally and never characterize them (see the
// generator rules in business-tracker.ts), which keeps them accurate but leaves
// "Type 20 — ACTIVE -> REVPEN" meaningless to a reader.
//
// Two constraints shape this:
//   1. It is emitted deterministically here, NOT written by the model. A
//      generated gloss could hallucinate a meaning for a legal status code.
//   2. It lands AFTER the footer's `---`, inside the region validators.ts
//      exempts from every gate. Putting expansions in the body instead would
//      hold the draft on Gate 1c: "California Department of Alcoholic Beverage
//      Control" is a proper name that appears nowhere in the corpus, the same
//      failure that held 2026-W33 on "Two ABC".
//
// Definitions state what a code stands for and stop there. Anything implying an
// outcome ("the license is being revoked") would be both wrong — REVPEN is
// pending, not final — and a characterization the records do not support.
//
// VERIFY AGAINST https://www.abc.ca.gov/licensing/license-types/ BEFORE RELYING
// ON THESE IN PUBLISHED COPY; they are hand-authored, not scraped.
const GLOSSARY: Array<{ match: RegExp; term: string; definition: string }> = [
	{
		match: /\bABC\b/,
		term: "ABC",
		definition:
			"California Department of Alcoholic Beverage Control, the state agency that licenses alcohol sales",
	},
	{
		match: /\bType 20\b/,
		term: "Type 20",
		definition:
			"a license to sell beer and wine for consumption off the premises",
	},
	{
		match: /\bType 21\b/,
		term: "Type 21",
		definition:
			"a license to sell beer, wine, and distilled spirits for consumption off the premises",
	},
	{
		match: /\bType 41\b/,
		term: "Type 41",
		definition:
			"a license to sell beer and wine for consumption on the premises of a restaurant",
	},
	{
		match: /\bACTIVE\b/,
		term: "ACTIVE",
		definition: "the license is in force",
	},
	{
		match: /\bREVPEN\b/,
		term: "REVPEN",
		definition:
			"revocation pending: the state has started a process that may end the license. The license is not revoked, and the record does not give a reason",
	},
	{
		match: /\bPEND\b/,
		term: "PEND",
		definition: "pending — the application or transfer has not been completed",
	},
	{
		match: /\bCANCEL\b/,
		term: "CANCEL",
		definition: "the license has been cancelled",
	},
	{
		match: /\bSURREND\b/,
		term: "SURREND",
		definition: "the license has been surrendered by its holder",
	},
];

// Only the codes a given post actually uses, in the order defined above.
export function glossaryFor(bodyMd: string): string {
	const hits = GLOSSARY.filter((g) => g.match.test(bodyMd));
	if (hits.length === 0) return "";
	return [
		"*What the record codes mean:*",
		"",
		...hits.map((g) => `- *${g.term} — ${g.definition}.*`),
	].join("\n");
}

// JSON string literals are valid YAML scalars — safe without a YAML dep.
function y(s: string): string {
	return JSON.stringify(s);
}

export function renderPostFile(p: NewPost, createdAt: string): string {
	const fm = [
		"---",
		`title: ${y(p.title)}`,
		`post_type: ${p.postType}`,
		`tier: ${p.tier}`,
		`date: ${y(createdAt)}`,
		...(p.meetingDate ? [`meeting_date: ${y(p.meetingDate)}`] : []),
		...(p.briefDate ? [`brief_date: ${y(p.briefDate)}`] : []),
		...(p.eventsAhead?.length
			? [
					"events_ahead:",
					...p.eventsAhead.flatMap((e) => [
						`  - date: ${y(e.date)}`,
						`    time: ${e.time === null ? "null" : y(e.time)}`,
						`    title: ${y(e.title)}`,
						`    venue: ${e.venue === null ? "null" : y(e.venue)}`,
						`    url: ${y(e.url)}`,
					]),
				]
			: []),
		"sources:",
		...p.sources.map((s) => `  - ${y(s)}`),
		"---",
	].join("\n");
	// The glossary shares the footer's exempt region: it must sit after the last
	// `---` and must not introduce an hr of its own, or it would become the last
	// hr and push the disclosure line out of the matched trailing text.
	const glossary = glossaryFor(p.bodyMd);
	const footer = glossary
		? `\n\n---\n\n${glossary}\n\n${DISCLOSURE_LINE}\n`
		: DISCLOSURE_FOOTER;
	return `${fm}\n\n${p.bodyMd.trim()}${footer}`;
}

function writePostFile(relPath: string, content: string): void {
	const abs = join(ROOT, relPath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

export function getPost(db: Db, slug: string): PostRow | undefined {
	return db.raw.prepare("SELECT * FROM posts WHERE slug = ?").get(slug) as
		| PostRow
		| undefined;
}

export function listPosts(db: Db, status?: PostStatus): PostRow[] {
	return (status
		? db.raw
				.prepare(
					"SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC",
				)
				.all(status)
		: db.raw
				.prepare("SELECT * FROM posts ORDER BY created_at DESC")
				.all()) as unknown as PostRow[];
}

// Idempotent create: same slug re-queued updates content in place; posts a
// human already published or rejected are never clobbered by a generator.
// `replacePublished` is the daily-brief exception: a same-day re-run must
// replace that day's already-published brief rather than duplicate or skip it.
// Rejected posts stay untouchable on every path — a human said no.
//
// `id` is null in one case: a terminal post was found on disk with no database
// row backing it (see the filesystem check below). There is no row to return an
// id for, and inventing one would be a lie. Callers care about `outcome`.
export function createPost(
	db: Db,
	p: NewPost,
	opts: { replacePublished?: boolean } = {},
): {
	id: number | null;
	filePath: string;
	outcome: "created" | "updated" | "skipped";
} {
	if (p.sources.length === 0)
		throw new Error(`post ${p.slug}: sources[] must not be empty`);
	const existing = getPost(db, p.slug);
	if (existing) {
		const untouchable =
			existing.status === "rejected" ||
			(existing.status === "published" && !opts.replacePublished);
		if (untouchable) {
			return {
				id: existing.id,
				filePath: existing.file_path,
				outcome: "skipped",
			};
		}
		writePostFile(existing.file_path, renderPostFile(p, existing.created_at));
		db.raw
			.prepare(
				"UPDATE posts SET post_type = ?, tier = ?, meeting_date = ?, source_count = ? WHERE id = ?",
			)
			.run(
				p.postType,
				p.tier,
				p.meetingDate ?? null,
				p.sources.length,
				existing.id,
			);
		return {
			id: existing.id,
			filePath: existing.file_path,
			outcome: "updated",
		};
	}
	// No database row — but the published artifact is the FILE, and the two can
	// drift apart: a database restored from backup, or a post generated on one
	// machine and committed as markdown while the row stayed behind. Trusting
	// the database alone is what let a generator recreate an already-live post
	// and overwrite hand-authored content — on 2026-08-18 a Tier A run silently
	// stripped three dated correction notes off published previews, which is
	// precisely the silent edit EDITORIAL.md forbids.
	//
	// So for the two TERMINAL states the filesystem gets the final say. `held`
	// and `queued` are deliberately not checked: nobody has decided about those
	// yet, and regenerating them in place is the idempotency the runners rely on.
	for (const status of ["published", "rejected"] as const) {
		if (status === "published" && opts.replacePublished) continue;
		const onDisk = join(DIR_BY_STATUS[status], `${p.slug}.md`);
		if (existsSync(join(ROOT, onDisk))) {
			return { id: null, filePath: onDisk, outcome: "skipped" };
		}
	}

	const createdAt = nowIso();
	const filePath = join(DIR_BY_STATUS.queued, `${p.slug}.md`);
	writePostFile(filePath, renderPostFile(p, createdAt));
	const res = db.raw
		.prepare(
			`INSERT INTO posts (slug, post_type, tier, status, file_path, meeting_date, source_count, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
		)
		.run(
			p.slug,
			p.postType,
			p.tier,
			filePath,
			p.meetingDate ?? null,
			p.sources.length,
			createdAt,
		);
	return { id: Number(res.lastInsertRowid), filePath, outcome: "created" };
}

export function transitionPost(
	db: Db,
	slug: string,
	to: PostStatus,
	opts: {
		heldReason?: string;
		gates?: unknown;
		judge?: unknown;
		publishedVia?: "auto" | "manual";
	} = {},
): PostRow {
	const row = getPost(db, slug);
	if (!row) throw new Error(`no post with slug ${slug}`);
	const newPath = join(DIR_BY_STATUS[to], `${row.slug}.md`);
	if (newPath !== row.file_path) {
		const absNew = join(ROOT, newPath);
		mkdirSync(dirname(absNew), { recursive: true });
		if (existsSync(join(ROOT, row.file_path)))
			renameSync(join(ROOT, row.file_path), absNew);
	}
	db.raw
		.prepare(
			`UPDATE posts SET status = ?, file_path = ?, held_reason = ?, gates = COALESCE(?, gates),
       judge = COALESCE(?, judge),
       published_via = CASE WHEN ? = 'published' THEN ? ELSE published_via END,
       published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END
       WHERE id = ?`,
		)
		.run(
			to,
			newPath,
			opts.heldReason ?? null,
			opts.gates !== undefined ? JSON.stringify(opts.gates) : null,
			opts.judge !== undefined ? JSON.stringify(opts.judge) : null,
			to,
			opts.publishedVia ?? "auto", // pipeline calls are the auto path; the dashboard passes 'manual'
			to,
			nowIso(),
			row.id,
		);
	const updated = getPost(db, slug);
	// The UPDATE above matched row.id, so this is unreachable; assert rather than
	// silence it, so a genuine desync surfaces instead of a confusing downstream undefined.
	if (!updated)
		throw new Error(`post ${slug} disappeared during transition to ${to}`);
	return updated;
}
