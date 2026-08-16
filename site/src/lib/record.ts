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
export function byNewest(a: Post, b: Post): number {
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

export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}
