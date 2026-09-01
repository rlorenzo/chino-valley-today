import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeBodyLinks, planRenames } from "./normalize-post-slugs.ts";

// The migration's job is narrow: lowercase the slugs written before
// createPost() normalized, and refuse anything it cannot do safely. posts.slug
// is UNIQUE, so a collision has to stop rather than pick a winner.

describe("planRenames", () => {
	it("plans a rename for an ISO-week slug and moves the file beside it", () => {
		const plans = planRenames([
			{
				id: 1,
				slug: "2026-W36-news-digest",
				file_path: "content/published/2026-W36-news-digest.md",
			},
		]);
		assert.equal(plans.length, 1);
		assert.equal(plans[0]?.to, "2026-w36-news-digest");
		assert.equal(plans[0]?.toPath, "content/published/2026-w36-news-digest.md");
		assert.equal(plans[0]?.blocked, undefined);
	});

	it("keeps the post in the status directory it is already in", () => {
		const plans = planRenames([
			{
				id: 1,
				slug: "2026-W33-business-narrative--rejected-20260815",
				file_path:
					"content/rejected/2026-W33-business-narrative--rejected-20260815.md",
			},
		]);
		assert.match(plans[0]?.toPath ?? "", /^content\/rejected\//);
	});

	it("leaves already-lowercase slugs out of the plan entirely", () => {
		const plans = planRenames([
			{
				id: 1,
				slug: "2026-08-31-daily-brief",
				file_path: "content/published/2026-08-31-daily-brief.md",
			},
		]);
		assert.deepEqual(plans, []);
	});

	it("blocks rather than clobbers when the lowercase slug is taken", () => {
		const plans = planRenames([
			{
				id: 1,
				slug: "2026-W36-news-digest",
				file_path: "content/published/2026-W36-news-digest.md",
			},
			{
				id: 2,
				slug: "2026-w36-news-digest",
				file_path: "content/queue/2026-w36-news-digest.md",
			},
		]);
		assert.equal(plans.length, 1);
		assert.match(plans[0]?.blocked ?? "", /already belongs to post id 2/);
	});
});

describe("normalizeBodyLinks", () => {
	it("lowercases an internal post link target and leaves the text alone", () => {
		const { next, count } = normalizeBodyLinks(
			"- [Chino Valley News Digest — 2026-W36](/posts/2026-W36-news-digest/)\n",
		);
		assert.equal(count, 1);
		assert.equal(
			next,
			"- [Chino Valley News Digest — 2026-W36](/posts/2026-w36-news-digest/)\n",
		);
	});

	it("touches nothing else — external links, prose, frontmatter", () => {
		const text = [
			"---",
			'title: "Daily Brief — 2026-W36"',
			"---",
			"",
			"The City of Chino Hills, per [CivicAlerts](https://www.chinohills.org/CivicAlerts.aspx?aid=3819).",
			"",
			"Measure W36 passed. See /posts/NOT-A-LINK/ in plain prose.",
			"",
		].join("\n");
		const { next, count } = normalizeBodyLinks(text);
		assert.equal(count, 0);
		assert.equal(next, text);
	});

	it("is a no-op on a body that is already correct", () => {
		const text = "- [Digest](/posts/2026-w36-news-digest/)\n";
		assert.deepEqual(normalizeBodyLinks(text), { next: text, count: 0 });
	});
});
