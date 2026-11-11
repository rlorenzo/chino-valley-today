import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CreatorPostWithCreator } from "../creators/store.ts";
import {
	assembleBrief,
	type BriefInputs,
	MAX_CREATOR_VIDEOS,
	renderCreatorVideoCards,
	selectCreatorVideos,
} from "./daily-brief.ts";
import { renderPostFile } from "./posts.ts";

// 6:05 AM PDT, Monday 2026-08-17; the previous brief went out a day earlier.
const NOW = new Date("2026-08-17T13:05:00.000Z");
const PREV = "2026-08-16T13:06:00.000Z";

let seq = 0;
function creatorPost(
	over: Partial<CreatorPostWithCreator> = {},
): CreatorPostWithCreator {
	seq++;
	const videoId = `73012345678901234${String(seq).padStart(2, "0")}`;
	return {
		id: seq,
		creator_id: 1,
		platform: "tiktok",
		video_id: videoId,
		url: `https://www.tiktok.com/@itsreallyty1/video/${videoId}`,
		description: `Post ${seq}`,
		origin: "manual",
		status: "published",
		review_ack: "ack",
		added_at: "2026-08-16T20:00:00.000Z",
		published_at: "2026-08-16T20:00:00.000Z",
		removed_at: null,
		removed_reason: null,
		handle: "itsreallyty1",
		display_name: "Ty",
		...over,
	};
}

function inputs(creatorPosts: CreatorPostWithCreator[]): BriefInputs {
	return {
		forecast: [],
		nwsAlerts: [],
		fire: [],
		calendarEvents: [],
		agendaItems: [],
		cvusdEvents: [],
		licenseEvents: [],
		publishedPosts: [],
		prevBriefPublishedAt: PREV,
		creatorPosts,
	};
}

describe("selectCreatorVideos", () => {
	test("only posts featured since the previous brief, newest first, capped", () => {
		const rows = [
			creatorPost({ published_at: "2026-08-15T10:00:00.000Z" }), // before
			creatorPost({ published_at: "2026-08-16T14:00:00.000Z" }),
			creatorPost({ published_at: "2026-08-16T22:00:00.000Z" }),
			creatorPost({ published_at: "2026-08-16T18:00:00.000Z" }),
			creatorPost({ published_at: "2026-08-17T01:00:00.000Z" }),
			creatorPost({ status: "removed" }),
		];
		const picked = selectCreatorVideos(rows, PREV);
		assert.equal(picked.length, MAX_CREATOR_VIDEOS);
		assert.deepEqual(
			picked.map((v) => v.description),
			[rows[4], rows[2], rows[3]].map((r) => r.description),
		);
	});
});

describe("creator cards in the brief", () => {
	test("render after the press, as attribution only", () => {
		const { post, notes } = assembleBrief(
			inputs([creatorPost({ description: "Tacos <b>& more</b>" })]),
			NOW,
		);
		assert.match(post.bodyMd, /## From local creators/);
		assert.match(post.bodyMd, /data-tiktok-play="\d{19}"/);
		// The play button starts hidden, so the card is a plain link with JS off.
		assert.match(post.bodyMd, / hidden>▶ Play here<\/button>/);
		// Operator text is escaped: raw HTML passes through markdown.
		assert.match(post.bodyMd, /Tacos &lt;b&gt;&amp; more&lt;\/b&gt;/);
		assert.equal(post.creatorVideos?.length, 1);
		// Never provenance.
		assert.ok(
			!post.sources.some((s) => /^https:\/\/www\.tiktok\.com\//.test(s)),
		);
		// A morning with creator posts is not "quiet".
		assert.doesNotMatch(post.bodyMd, /quiet morning/);
		assert.ok(notes.some((n) => /local creators: 1 video/.test(n)));
	});

	test("no posts, no section and no frontmatter key", () => {
		const { post } = assembleBrief(inputs([]), NOW);
		assert.doesNotMatch(post.bodyMd, /From local creators/);
		assert.equal(post.creatorVideos, undefined);
		assert.doesNotMatch(
			renderPostFile(post, NOW.toISOString()),
			/creator_videos/,
		);
	});

	test("frontmatter lists each video for the site's script include", () => {
		const { post } = assembleBrief(inputs([creatorPost()]), NOW);
		const file = renderPostFile(post, NOW.toISOString());
		assert.match(
			file,
			/^creator_videos:\n {2}- video_id: "\d{19}"\n {4}url: "https:\/\/www\.tiktok\.com\/@itsreallyty1\/video\/\d{19}"/m,
		);
		assert.match(
			file,
			/profile_url: "https:\/\/www\.tiktok\.com\/@itsreallyty1"/,
		);
	});

	test("renderCreatorVideoCards renders nothing for nothing", () => {
		assert.deepEqual(renderCreatorVideoCards([]), []);
	});
});
