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
	"daily-brief": "Daily brief",
};

export function typeLabel(type: string): string {
	return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

export function isBrief(post: Post): boolean {
	return post.data.post_type === "daily-brief";
}

/**
 * A daily brief's canonical home is its date (/brief/YYYY-MM-DD); everything
 * else lives under /posts/. One helper so no page hardcodes the split.
 */
export function postUrl(post: Post): string {
	return isBrief(post) && post.data.brief_date
		? `/brief/${post.data.brief_date}/`
		: `/posts/${post.id}/`;
}

/** Daily briefs, newest brief day first. */
export function briefsOnly(posts: Post[]): Post[] {
	return posts
		.filter((p) => isBrief(p) && p.data.brief_date)
		.sort((a, b) =>
			(b.data.brief_date ?? "").localeCompare(a.data.brief_date ?? ""),
		);
}

/**
 * The citable spine: everything except the daily briefs, which are a morning
 * assembly OF the record rather than entries IN it.
 */
export function recordOnly(posts: Post[]): Post[] {
	return posts.filter((p) => !isBrief(p));
}

/** Today's date in America/Los_Angeles as YYYY-MM-DD, at build time. */
export function laToday(now: Date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

/** The YYYY-MM-DD `days` calendar days after a YYYY-MM-DD date. */
export function laDatePlus(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** "Monday, August 17, 2026" for a YYYY-MM-DD local calendar date. */
export function formatLocalDateLong(date: string): string {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
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

	// A preview's summary is WHEN it is and WHETHER AN AGENDA EXISTS. The address
	// is deliberately omitted: these meetings are all at the same city hall, so
	// it is the least informative fact available and it costs the line that the
	// agenda status should occupy. A cancellation outranks everything — it
	// changes whether the meeting happens at all.
	if (post.data.post_type === "meeting_preview") {
		if (/cancell?ed/i.test(body)) {
			return "CANCELLED — this meeting will not take place.";
		}

		const when = [field("Date"), field("Time")].filter(Boolean).join(", ");
		// The generator either lists cross-referenced agenda items under an
		// "Agenda" heading, or states that none had been posted.
		const agendaItems = body.includes("### Agenda")
			? body
					.slice(body.indexOf("### Agenda"))
					.split("\n")
					.filter((l) => /^-\s+\S/.test(l)).length
			: 0;
		const agenda = agendaItems
			? `${agendaItems} agenda ${agendaItems === 1 ? "item" : "items"} posted`
			: "no agenda posted yet";
		return truncate([when, agenda].filter(Boolean).join(" · "));
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
