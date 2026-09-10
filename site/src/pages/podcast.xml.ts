import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { podcastsOnly, postUrl, publishedOnly } from "../lib/record.ts";

// A dedicated feed rather than folding these into rss.xml: podcast clients
// (Apple, Spotify, Overcast) expect an itunes-tagged feed of nothing but
// episodes, with an enclosure on every item. rss.xml still lists episodes
// too, as ordinary record entries, for readers who follow the general feed.
export async function GET(context: APIContext) {
	const site = context.site ?? new URL("https://chinovalley.today");
	const episodes = podcastsOnly(publishedOnly(await getCollection("posts")));

	// Escaped: this is the one value here that comes from outside the build.
	const ownerEmail = (process.env.CVT_PODCAST_OWNER_EMAIL ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	const owner = ownerEmail
		? `<itunes:owner><itunes:name>Chino Valley Today</itunes:name><itunes:email>${ownerEmail}</itunes:email></itunes:owner>`
		: "";
	const coverUrl = new URL("/podcast-cover.png", site).href;

	return rss({
		title: "Chino Valley Today, the Week in Review",
		description:
			"An automated weekly recap of Chino and Chino Hills government, read by two synthetic voices. Every story is linked to its primary source.",
		site,
		xmlns: {
			itunes: "http://www.itunes.com/dtds/podcast-1.0.dtd",
			podcast: "https://podcastindex.org/namespace/1.0",
			content: "http://purl.org/rss/1.0/modules/content/",
		},
		customData: [
			"<language>en-us</language>",
			"<itunes:author>Chino Valley Today</itunes:author>",
			owner,
			`<itunes:image href="${coverUrl}"/>`,
			'<itunes:category text="News"><itunes:category text="Politics"/></itunes:category>',
			"<itunes:explicit>false</itunes:explicit>",
			"<itunes:type>episodic</itunes:type>",
		].join(""),
		items: episodes.map((post) => {
			const episodeUrl = new URL(postUrl(post), site).href;
			const chaptersUrl = new URL(`/audio/${post.id}.chapters.json`, site).href;
			const storyCount = post.data.sources.length;
			return {
				title: post.data.title,
				pubDate: post.data.date,
				link: postUrl(post),
				description: `${post.data.title}. ${storyCount} ${storyCount === 1 ? "story" : "stories"}, every claim linked to its source.`,
				enclosure: post.data.audio_url
					? {
							url: post.data.audio_url,
							length: post.data.audio_bytes ?? 0,
							type: "audio/mpeg",
						}
					: undefined,
				// rss() already emits <guid isPermaLink="true"> from `link`, so none
				// is added here.
				customData: [
					post.data.duration_sec !== undefined
						? `<itunes:duration>${post.data.duration_sec}</itunes:duration>`
						: "",
					"<itunes:explicit>false</itunes:explicit>",
					`<podcast:transcript url="${episodeUrl}" type="text/html"/>`,
					`<podcast:chapters url="${chaptersUrl}" type="application/json+chapters"/>`,
				].join(""),
			};
		}),
	});
}
