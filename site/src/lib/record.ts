import type { CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"posts">;

export const TOPICS = [
	{
		slug: "planning",
		name: "Planning",
		blurb: "Development, land use, and the commissions that rule on it.",
	},
	{
		slug: "cvusd",
		name: "CVUSD",
		blurb: "Chino Valley Unified School District Board of Education.",
	},
	{
		slug: "business",
		name: "Business",
		blurb: "Licences, applications, and business items on the record.",
	},
	{
		slug: "safety",
		name: "Safety",
		blurb: "Alerts and public-safety notices from agency channels.",
	},
] as const;

export type TopicSlug = (typeof TOPICS)[number]["slug"];

/**
 * Topics are DERIVED here, not carried in frontmatter.
 *
 * The pipeline does not emit a topic field, so this is the site's own
 * deterministic reading of post_type plus title. It is deliberately
 * conservative: a post is filed under a topic only when the evidence is
 * unambiguous, because mis-filing a civic record is worse than leaving it
 * untagged. Untagged posts still appear in the main record, which is the
 * complete set.
 *
 * This belongs in the pipeline eventually — it owns the source keys and item
 * types that would classify far more accurately than a title match can.
 */
export function topicsFor(post: Post): TopicSlug[] {
	const hay = `${post.data.title} ${post.id}`.toLowerCase();
	const type = post.data.post_type;
	const topics = new Set<TopicSlug>();

	if (type === "business_tracker" || type === "business_narrative") {
		topics.add("business");
	}
	if (type === "alert") topics.add("safety");

	if (/cvusd|board of education/.test(hay)) topics.add("cvusd");
	if (/planning/.test(hay)) topics.add("planning");
	if (/sheriff|nixle|alert|evacuat|closure/.test(hay)) topics.add("safety");

	return [...topics];
}

/** Newest first — a record reads backwards from now. */
function byNewest(a: Post, b: Post): number {
	return b.data.date.getTime() - a.data.date.getTime();
}

/** Only what a human approved. Queue, held and rejected never reach the site. */
export function publishedOnly(posts: Post[]): Post[] {
	return [...posts].sort(byNewest);
}

const TYPE_LABEL: Record<string, string> = {
	meeting_preview: "Preview",
	meeting_recap: "Recap",
	business_tracker: "Business tracker",
	business_narrative: "Business tracker",
	news_digest: "Digest",
	alert: "Alert",
};

export function typeLabel(type: string): string {
	return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

/**
 * The host a source was checked against, for the stamp face. A stamp reading
 * "abc.ca.gov" tells a reader which authority stands behind the line; a stamp
 * reading "source" tells them nothing.
 */
export function sourceHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "source";
	}
}

export function formatDate(d: Date): string {
	return d.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "America/Los_Angeles",
	});
}

export function formatDateLong(d: Date): string {
	return d.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "America/Los_Angeles",
	});
}

/* ---------------------------------------------------------------------------
 * Deks — the one-line summary each index entry needs.
 *
 * A title like "Recap: Chino City Council meeting of 2026-07-21" tells a reader
 * nothing about what their government actually did, and residents are the
 * primary audience. The posts already contain the answer, but in a different
 * shape per post type, so this reads each shape on its own terms rather than
 * grabbing the first paragraph and hoping.
 *
 * Derived, not authored: every word below comes from the post itself. The
 * pipeline should eventually emit a real summary field — it knows far more than
 * a text scan can — and this becomes a fallback when it does.
 * ------------------------------------------------------------------------- */

/** Markdown to plain prose: links to their text, bold/italic to their words. */
function plain(md: string): string {
	return md
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(s: string, max = 190): string {
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const at = cut.lastIndexOf(" ");
	return `${cut.slice(0, at > 60 ? at : max).replace(/[,;:.\s]+$/, "")}…`;
}

/** The body with the pipeline's glossary and disclosure footer removed. */
function bodyWithoutFooter(body: string): string {
	const i = body.lastIndexOf("\n---");
	return i > 0 ? body.slice(0, i) : body;
}

export function dek(post: Post): string | null {
	const body = bodyWithoutFooter(post.body ?? "");
	const blocks = body
		.split(/\n\s*\n/)
		.map((b) => b.trim())
		.filter(Boolean);

	const field = (name: string) => {
		const m = body.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([^\\n(]+)`, "i"));
		return m ? plain(m[1]).replace(/[.\s]+$/, "") : null;
	};

	// A preview's summary is WHEN and WHERE — that is what a reader deciding
	// whether to attend needs, and it is why this is keyed on post type rather
	// than left to whichever paragraph happens to come first. A cancellation
	// outranks both: it changes whether the meeting exists at all.
	if (post.data.post_type === "meeting_preview") {
		const cancelled = /cancell?ed/i.test(body);
		const when = [field("Date"), field("Time")].filter(Boolean).join(", ");
		const where = field("Location");
		const detail = [when, where].filter(Boolean).join(" · ");
		if (cancelled)
			return truncate(detail ? `CANCELLED — ${detail}` : "CANCELLED");
		if (detail) return truncate(detail);
	}

	// Recaps and narratives open with a real lede paragraph — use it. A block
	// that is only a link ("City calendar entry") is a citation, not a summary,
	// so it must not satisfy this branch.
	const paragraph = blocks.find((b) => {
		if (b.startsWith("-") || b.startsWith("#") || b.startsWith(">"))
			return false;
		const bare = b.replace(/\[([^\]]+)\]\([^)]*\)/g, "").trim();
		if (bare.length < 25) return false;
		return plain(b).length >= 40;
	});
	if (paragraph) return truncate(plain(paragraph));

	// Listing posts (digests, licence trackers) are a set of entries. Say how
	// many, and name the first — a count alone is not a summary.
	const items = body.split("\n").filter((l) => /^-\s+\S/.test(l));
	if (items.length) {
		const first = plain(items[0].replace(/^-\s+/, "")).split(/\s+—\s+/)[0];
		return truncate(
			items.length > 1
				? `${items.length} entries, including ${first}`
				: `1 entry: ${first}`,
		);
	}

	return null;
}
