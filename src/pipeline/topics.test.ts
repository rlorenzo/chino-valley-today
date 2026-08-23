import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTopics, TOPIC_SLUGS } from "./topics.ts";

describe("classifyTopics", () => {
	it("files an alert post under safety", () => {
		assert.deepEqual(
			classifyTopics({
				postType: "alert",
				title: "Weather Alert: Heat Advisory",
				sourceKeys: ["nws-alerts"],
				itemTypes: ["alert"],
			}),
			["safety"],
		);
	});

	it("absorbs fire and EMS into safety rather than inventing a mark", () => {
		// The 2026-08-23 ruling: a resident who saw smoke does not distinguish
		// "an agency issued a notice" from "something happened".
		for (const key of ["cvfd-news", "sbcfire-news"]) {
			assert.deepEqual(
				classifyTopics({ postType: "meeting_recap", sourceKeys: [key] }),
				["safety"],
				`${key} should file under safety`,
			);
		}
		assert.deepEqual(
			classifyTopics({
				postType: "alert",
				itemTypes: ["fire_incident"],
			}),
			["safety"],
		);
	});

	it("files business tracker and narrative posts under business", () => {
		assert.deepEqual(classifyTopics({ postType: "business_tracker" }), [
			"business",
		]);
		assert.deepEqual(classifyTopics({ postType: "business_narrative" }), [
			"business",
		]);
	});

	it("distinguishes a planning commission preview from a council preview", () => {
		// Same source key, same item type, same host — the body name in the title
		// is the only thing that separates them, which is why the title is read
		// for exactly this and nothing else.
		const base = {
			postType: "meeting_preview",
			sourceKeys: ["chino-news-rss"],
			itemTypes: ["event"],
		};
		assert.deepEqual(
			classifyTopics({
				...base,
				title: "Meeting Preview: Planning Commission — August 19, 2026",
			}),
			["planning"],
		);
		assert.deepEqual(
			classifyTopics({
				...base,
				title: "Meeting Preview: City Council — September 1, 2026",
			}),
			[],
			"a council preview names no subject, so it stays untagged",
		);
	});

	it("files CVUSD by source key even when the title does not say so", () => {
		assert.deepEqual(
			classifyTopics({
				postType: "meeting_preview",
				title: "Meeting Preview: Regular Meeting — August 20, 2026",
				sourceKeys: ["cvusd-board"],
			}),
			["cvusd"],
		);
	});

	it("gives daily briefs and news digests no topic", () => {
		// Both span every subject; filing them would put them under every mark.
		assert.deepEqual(
			classifyTopics({
				postType: "daily-brief",
				title: "Saturday, August 22, 2026",
				sourceKeys: ["nws-alerts"],
				itemTypes: ["alert"],
			}),
			[],
		);
		assert.deepEqual(
			classifyTopics({
				postType: "news_digest",
				sourceKeys: ["chinohills-news-rss"],
			}),
			[],
		);
	});

	it("excludes secondary press even when another signal would file it", () => {
		// Attribution is not the record. The exclusion has to outrank positive
		// signals rather than race them.
		assert.deepEqual(
			classifyTopics({
				postType: "meeting_recap",
				title: "Planning Commission votes 3-2 on wall murals",
				sourceKeys: ["champion-news"],
				itemTypes: ["news_article"],
			}),
			[],
		);
	});

	it("still files a post that merely cites press alongside a primary source", () => {
		// Only an all-press post is excluded: a record post that happens to cite
		// an outlet is still the record.
		assert.deepEqual(
			classifyTopics({
				postType: "business_tracker",
				sourceKeys: ["abc-licenses", "champion-news"],
			}),
			["business"],
		);
	});

	it("falls back to source hosts when no source key is available", () => {
		// The backfill path: a published file carries URLs, not source keys.
		assert.deepEqual(
			classifyTopics({
				postType: "meeting_preview",
				title: "Meeting Preview: Regular Meeting — August 20, 2026",
				sources: ["https://files.smartsites.parentsquare.com/agenda.pdf"],
			}),
			["cvusd"],
		);
	});

	it("ignores hosts once real source keys are present", () => {
		// Source keys are the stronger signal; consulting both could file a post
		// twice over from one piece of evidence.
		assert.deepEqual(
			classifyTopics({
				postType: "meeting_preview",
				sourceKeys: ["chino-news-rss"],
				sources: ["https://abc.ca.gov/report.csv"],
			}),
			[],
		);
	});

	it("never throws on a malformed source URL", () => {
		assert.deepEqual(
			classifyTopics({ postType: "meeting_preview", sources: ["not a url"] }),
			[],
		);
	});

	it("returns topics in a stable order regardless of signal order", () => {
		const a = classifyTopics({
			postType: "meeting_preview",
			sourceKeys: ["cvusd-board", "nws-alerts"],
		});
		const b = classifyTopics({
			postType: "meeting_preview",
			sourceKeys: ["nws-alerts", "cvusd-board"],
		});
		assert.deepEqual(a, b);
		assert.deepEqual(a, ["cvusd", "safety"]);
	});

	it("never returns a slug outside the declared taxonomy", () => {
		const every = classifyTopics({
			postType: "business_tracker",
			title: "Planning Commission and Board of Education",
			sourceKeys: ["cvusd-board", "nws-alerts", "abc-licenses"],
			itemTypes: ["game_result"],
		});
		for (const slug of every) {
			assert.ok(
				(TOPIC_SLUGS as readonly string[]).includes(slug),
				`${slug} is not a declared topic`,
			);
		}
	});
});
