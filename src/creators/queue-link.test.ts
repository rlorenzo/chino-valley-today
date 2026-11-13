import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db/index.ts";
import { refFromShared } from "./queue-link.ts";
import {
	addCreator,
	listCreatorPosts,
	publishSharedPost,
	rejectQueuedPost,
} from "./store.ts";
import type { FetchLike, TikTokVideoRef } from "./tiktok.ts";

// What the TikTok API poll leaves behind (src/creators/connections.ts).
function queue(db: ReturnType<typeof openDb>, ref: TikTokVideoRef): void {
	const c = addCreator(db, { handle: `q${ref.videoId}`, displayName: "q" });
	db.raw
		.prepare(
			`INSERT INTO creator_posts (creator_id, platform, video_id, url, description, origin, status, added_at)
			 VALUES (?, 'tiktok', ?, ?, '', 'api', 'queued', ?)`,
		)
		.run(c.id, ref.videoId, ref.url, new Date().toISOString());
}

const LINK = "https://www.tiktok.com/@ItsReallyTy1/video/7301234567890123456";

test("share text: the first link is used, short links resolve, junk is refused", async () => {
	const ref = await refFromShared(`Check out Ty's video! ${LINK}?_r=1 #chino`);
	assert.equal(typeof ref === "object" && ref.handle, "itsreallyty1");

	const redirect: FetchLike = async () => ({
		status: 301,
		headers: { get: () => LINK },
	});
	const short = await refFromShared(
		"https://vm.tiktok.com/ZMabc123/",
		redirect,
	);
	assert.equal(
		typeof short === "object" && short.videoId,
		"7301234567890123456",
	);

	assert.equal(
		await refFromShared("rm -rf /; echo hi"),
		"No link found in what was shared.",
	);
	assert.equal(
		await refFromShared("https://example.com/x"),
		"That is not a TikTok link.",
	);
});

test("a shared link publishes, approves a queued copy, and never revives", async () => {
	const db = openDb(":memory:");
	const ref = await refFromShared(LINK);
	assert.ok(typeof ref === "object");
	assert.match(publishSharedPost(db, ref, "A video from @x."), /Published/);
	assert.equal(listCreatorPosts(db, "published").length, 1);
	assert.throws(() => publishSharedPost(db, ref, "again"), /already featured/);

	const queued = { ...ref, videoId: "7301234567890123499" };
	queue(db, queued);
	publishSharedPost(db, queued, "line");
	assert.equal(listCreatorPosts(db, "queued").length, 0);
	assert.equal(listCreatorPosts(db, "published").length, 2);

	const rejected = { ...ref, videoId: "7301234567890123500" };
	queue(db, rejected);
	rejectQueuedPost(db, listCreatorPosts(db, "queued")[0].id);
	assert.throws(
		() => publishSharedPost(db, rejected, "line"),
		/rejected earlier/,
	);
	assert.equal(listCreatorPosts(db, "published").length, 2);
});
