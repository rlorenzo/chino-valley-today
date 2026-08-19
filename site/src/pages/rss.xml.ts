import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { postUrl, publishedOnly, typeLabel } from "../lib/record.ts";

export async function GET(context: APIContext) {
	const posts = publishedOnly(await getCollection("posts"));

	return rss({
		title: "Chino Valley Today",
		description:
			"What the Chino and Chino Hills city councils, the CVUSD board, and the commissions actually did — every civic claim linked to the primary record.",
		// context.site comes from astro.config's CVT_SITE_ORIGIN, so the feed follows
		// the deploy target rather than hardcoding a second copy of the origin.
		site: context.site ?? "https://chinovalley.today",
		items: posts.map((post) => ({
			title: post.data.title,
			pubDate: post.data.date,
			link: postUrl(post),
			// The feed carries the same provenance the page does: a reader in a
			// feed client can still see which authority each entry rests on
			// without loading the site.
			description: [
				typeLabel(post.data.post_type),
				post.data.meeting_date ? `meeting ${post.data.meeting_date}` : null,
				`${post.data.sources.length} source${post.data.sources.length === 1 ? "" : "s"}`,
			]
				.filter(Boolean)
				.join(" · "),
		})),
		customData: "<language>en-us</language>",
	});
}
