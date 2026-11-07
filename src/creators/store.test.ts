import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { creatorsExport, writeCreatorsFiles } from "./export.ts";
import {
	addCreator,
	addManualPost,
	approveQueuedPost,
	CREATOR_POST_ACK,
	CreatorInputError,
	listCreatorPosts,
	listCreators,
	removeCreator,
	removePost,
} from "./store.ts";
import { canonicalVideoUrl } from "./tiktok.ts";

const ID = "7301234567890123456";
const ref = (handle: string, videoId = ID) => ({
	handle,
	videoId,
	url: canonicalVideoUrl(handle, videoId),
});

function seeded() {
	const db = openDb(":memory:");
	addCreator(db, {
		handle: "@ItsReallyTy1",
		displayName: "Ty",
		covers: "Food in Chino",
		consentAt: "2026-11-07",
		consentNote: "DM reply",
	});
	addCreator(db, { handle: "unasked", displayName: "Not Asked" });
	return db;
}

describe("creators", () => {
	test("handles are stored normalized and duplicates refused", () => {
		const db = seeded();
		// Ordered by display name: "Not Asked" before "Ty".
		assert.deepEqual(
			listCreators(db).map((c) => c.handle),
			["unasked", "itsreallyty1"],
		);
		assert.throws(
			() => addCreator(db, { handle: "itsreallyty1", displayName: "x" }),
			CreatorInputError,
		);
	});

	test("a bad consent date is refused", () => {
		const db = openDb(":memory:");
		assert.throws(
			() =>
				addCreator(db, {
					handle: "abc",
					displayName: "A",
					consentAt: "Nov 7",
				}),
			CreatorInputError,
		);
	});
});

describe("featured posts", () => {
	test("a manual add needs the acknowledgment, and records it", () => {
		const db = seeded();
		assert.throws(
			() =>
				addManualPost(db, {
					ref: ref("itsreallyty1"),
					description: "Tacos",
					ack: false,
				}),
			/review box/,
		);
		const row = addManualPost(db, {
			ref: ref("itsreallyty1"),
			description: "  A tour of the\nnew taco spot  ",
			ack: true,
		});
		assert.equal(row.status, "published");
		assert.equal(row.origin, "manual");
		assert.equal(row.review_ack, CREATOR_POST_ACK);
		assert.equal(row.description, "A tour of the new taco spot");
	});

	test("only listed creators' posts can be featured", () => {
		const db = seeded();
		assert.throws(
			() =>
				addManualPost(db, {
					ref: ref("stranger"),
					description: "x",
					ack: true,
				}),
			/not on the creators list/,
		);
	});

	test("the description is required and bounded", () => {
		const db = seeded();
		for (const description of ["", "   ", "x".repeat(201)]) {
			assert.throws(
				() =>
					addManualPost(db, {
						ref: ref("itsreallyty1"),
						description,
						ack: true,
					}),
				CreatorInputError,
			);
		}
	});

	test("a featured video cannot be added twice; a removed one can come back", () => {
		const db = seeded();
		const input = {
			ref: ref("itsreallyty1"),
			description: "Tacos",
			ack: true,
		};
		const row = addManualPost(db, input);
		assert.throws(() => addManualPost(db, input), /already featured/);
		removePost(db, row.id, "creator asked");
		assert.equal(listCreatorPosts(db, "published").length, 0);
		assert.equal(
			listCreatorPosts(db, "removed")[0].removed_reason,
			"creator asked",
		);
		const back = addManualPost(db, { ...input, description: "Back again" });
		assert.equal(back.id, row.id);
		assert.equal(back.status, "published");
		assert.equal(back.removed_at, null);
	});

	test("removing a creator takes their posts down with them", () => {
		const db = seeded();
		addManualPost(db, {
			ref: ref("itsreallyty1"),
			description: "Tacos",
			ack: true,
		});
		const ty = listCreators(db).find((c) => c.handle === "itsreallyty1");
		removeCreator(db, ty?.id ?? 0, "asked to be removed");
		assert.equal(listCreatorPosts(db, "published").length, 0);
		assert.throws(
			() =>
				addManualPost(db, {
					ref: ref("itsreallyty1", "7301234567890123457"),
					description: "x",
					ack: true,
				}),
			/not on the creators list/,
		);
	});

	test("a queued (API) post needs the same acknowledgment to publish", () => {
		const db = seeded();
		const ty = listCreators(db).find((c) => c.handle === "itsreallyty1");
		db.raw
			.prepare(
				`INSERT INTO creator_posts (creator_id, platform, video_id, url, description, origin, status, added_at)
				 VALUES (?, 'tiktok', ?, ?, ?, 'api', 'queued', ?)`,
			)
			.run(
				ty?.id ?? 0,
				ID,
				canonicalVideoUrl("itsreallyty1", ID),
				"caption-derived draft",
				"2026-11-07T00:00:00Z",
			);
		const queued = listCreatorPosts(db, "queued")[0];
		assert.throws(
			() => approveQueuedPost(db, queued.id, { description: "x", ack: false }),
			/review box/,
		);
		approveQueuedPost(db, queued.id, {
			description: "Our own line",
			ack: true,
		});
		const published = listCreatorPosts(db, "published")[0];
		assert.equal(published.description, "Our own line");
		assert.equal(published.review_ack, CREATOR_POST_ACK);
	});
});

describe("site export", () => {
	test("profiles only for consenting creators; posts for anyone featured", () => {
		const db = seeded();
		addManualPost(db, {
			ref: ref("unasked"),
			description: "Sunset over Prado",
			ack: true,
		});
		const out = creatorsExport(db);
		assert.deepEqual(
			out.creators.map((c) => c.handle),
			["itsreallyty1"],
		);
		assert.equal(out.videos.length, 1);
		assert.equal(out.videos[0].id, ID);
		assert.equal(out.videos[0].profile_url, "https://www.tiktok.com/@unasked");
	});

	test("writes both files whole, as JSON arrays", () => {
		const db = seeded();
		const dir = mkdtempSync(join(tmpdir(), "cvt-creators-"));
		try {
			writeCreatorsFiles(db, dir);
			const creators = JSON.parse(
				readFileSync(join(dir, "creators.json"), "utf8"),
			);
			const videos = JSON.parse(readFileSync(join(dir, "videos.json"), "utf8"));
			assert.equal(creators.length, 1);
			assert.deepEqual(videos, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
