import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db/index.ts";
import { refFromShared } from "./queue-link.ts";
import {
	approveQueuedPost,
	CreatorInputError,
	listCreatorPosts,
	queueSharedPost,
	rejectQueuedPost,
} from "./store.ts";
import type { FetchLike } from "./tiktok.ts";

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

test("a shared link only queues, and never revives a rejected video", async () => {
	const db = openDb(":memory:");
	const ref = await refFromShared(LINK);
	assert.ok(typeof ref === "object");
	assert.equal(queueSharedPost(db, ref), "Queued @itsreallyty1 for review.");
	const [post] = listCreatorPosts(db, "queued");
	assert.equal(post.status, "queued");
	assert.equal(listCreatorPosts(db, "published").length, 0);
	assert.throws(() => queueSharedPost(db, ref), /already waiting/);

	rejectQueuedPost(db, post.id);
	assert.throws(() => queueSharedPost(db, ref), CreatorInputError);
	assert.equal(listCreatorPosts(db, "queued").length, 0);

	// The dashboard approval path still works on a shared post.
	const other = {
		...ref,
		videoId: "7301234567890123499",
		url: LINK.replace("3456", "3499"),
	};
	queueSharedPost(db, other);
	const queued = listCreatorPosts(db, "queued")[0];
	approveQueuedPost(db, queued.id, {
		description: "Boba on Central",
		ack: true,
	});
	assert.equal(listCreatorPosts(db, "published").length, 1);
});
