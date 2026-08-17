import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// This schema is the last-line validator, after Gate 1 and Gate 2.
//
// It mirrors exactly what renderPostFile() in src/pipeline/posts.ts writes. That
// is the point of using content collections here: a post whose frontmatter drifts
// from the pipeline's output fails the BUILD rather than publishing malformed, so
// a schema change on either side surfaces immediately instead of silently
// shipping a broken page.
//
// Posts are read from the repo's own content/published/ directory — the site does
// not own or copy the corpus, it renders it. Only `published` is built; queue,
// held and rejected are working state and must never reach the public site.
const posts = defineCollection({
	loader: glob({
		pattern: "**/*.md",
		base: "../content/published",
	}),
	schema: z
		.object({
			title: z.string(),

			// Every value the pipeline can emit. `business_narrative` is included
			// deliberately: it is live in content/published/ but still missing from the
			// NewPost union in posts.ts, which uses a commented cast. If that union is
			// ever widened, this list is the other half of the change.
			post_type: z.enum([
				"meeting_preview",
				"meeting_recap",
				"business_tracker",
				"business_narrative",
				"news_digest",
				"alert",
				"daily-brief",
			]),

			// EDITORIAL.md's routing tiers. Tier C reaching a build at all means a human
			// approved it with an explicit acknowledgment; the site does not re-decide.
			tier: z.enum(["A", "B", "C"]),

			date: z.coerce.date(),
			meeting_date: z.string().optional(),

			// The LA calendar day a daily brief covers; it is the brief's permalink
			// (/brief/YYYY-MM-DD) and its identity, so a brief without one is a
			// build failure, not a page at a broken URL.
			brief_date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional(),

			// Provenance is structural, not decorative: EDITORIAL.md's first rule is
			// "no source, no claim". A post with an empty sources list is a build
			// failure, not a page with a missing footer.
			sources: z.array(z.string().url()).nonempty(),
		})
		.refine(
			(d) => d.post_type !== "daily-brief" || d.brief_date !== undefined,
			{
				message: "a daily-brief post must carry brief_date",
			},
		),
});

export const collections = { posts };
