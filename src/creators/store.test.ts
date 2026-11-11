import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { renderCreatorVideoCards } from "../pipeline/daily-brief.ts";
import {
	creatorsExport,
	scrubBriefs,
	scrubBriefText,
	writeCreatorsFiles,
} from "./export.ts";
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
	test("handles are stored normalized; a repeat updates the same row", () => {
		const db = seeded();
		// Ordered by display name: "Not Asked" before "Ty".
		assert.deepEqual(
			listCreators(db).map((c) => c.handle),
			["unasked", "itsreallyty1"],
		);
		addCreator(db, { handle: "@ItsReallyTy1", displayName: "Ty B" });
		const rows = listCreators(db).filter((c) => c.handle === "itsreallyty1");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].display_name, "Ty B");
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

	test("a post by an unlisted creator adds them, without consent", () => {
		const db = seeded();
		addManualPost(db, {
			ref: ref("stranger"),
			description: "x",
			ack: true,
			displayName: "Stranger",
		});
		const c = listCreators(db).find((r) => r.handle === "stranger");
		assert.equal(c?.display_name, "Stranger");
		assert.equal(c?.consent_at, null);
		addManualPost(db, {
			ref: ref("nameless", "7301234567890123499"),
			description: "x",
			ack: true,
		});
		const n = listCreators(db).find((r) => r.handle === "nameless");
		assert.equal(n?.display_name, "nameless");
	});

	test("consent can be recorded later for a creator added from a post", () => {
		const db = seeded();
		addManualPost(db, { ref: ref("stranger"), description: "x", ack: true });
		const before = listCreators(db).find((r) => r.handle === "stranger");
		addCreator(db, {
			handle: "@stranger",
			displayName: "Stranger",
			consentAt: "2026-11-10",
			consentNote: "Replied yes to a DM",
		});
		const after = listCreators(db).find((r) => r.handle === "stranger");
		assert.equal(after?.id, before?.id);
		assert.equal(after?.added_at, before?.added_at);
		assert.equal(after?.consent_at, "2026-11-10");
		assert.equal(listCreatorPosts(db, "published").length, 1);
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
			/was removed from the creators list/,
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

describe("removal reaches published briefs", () => {
	const OTHER = "7301234567890123999";
	const video = (video_id: string) => ({
		video_id,
		url: canonicalVideoUrl("itsreallyty1", video_id),
		handle: "itsreallyty1",
		display_name: "Ty",
		profile_url: "https://www.tiktok.com/@itsreallyty1",
		description: "Tacos",
	});
	// The same shapes renderCreatorVideoCards and renderPostFile write.
	const brief = (ids: string[]) =>
		[
			"---",
			'title: "Brief"',
			"creator_videos:",
			...ids.flatMap((id) => [
				`  - video_id: "${id}"`,
				`    url: "${video(id).url}"`,
				'    handle: "itsreallyty1"',
			]),
			"sources:",
			'  - "https://example.org/"',
			"---",
			"",
			"## Weather",
			"",
			"Sunny.",
			"",
			...renderCreatorVideoCards(ids.map(video)),
			"---",
			"",
			"footer",
			"",
		].join("\n");

	test("one of two cards goes, the section stays", () => {
		const out = scrubBriefText(brief([ID, OTHER]), new Set([ID]));
		assert.ok(!out.includes(ID));
		assert.match(out, /## From local creators/);
		assert.match(out, new RegExp(`data-tiktok-play="${OTHER}"`));
		assert.match(
			out,
			new RegExp(`creator_videos:\n {2}- video_id: "${OTHER}"`),
		);
	});

	test("the last card takes the section and the frontmatter key with it", () => {
		const out = scrubBriefText(brief([ID]), new Set([ID]));
		assert.ok(!out.includes(ID));
		assert.ok(!out.includes("From local creators"));
		assert.ok(!out.includes("creator_videos"));
		assert.match(out, /Sunny\.\n\n---\n\nfooter/);
		assert.match(out, /sources:\n {2}- "https:\/\/example\.org\/"/);
	});

	test("removing a post rewrites the brief file; other files are untouched", () => {
		const db = seeded();
		const post = addManualPost(db, {
			ref: ref("itsreallyty1"),
			description: "Tacos",
			ack: true,
		});
		const dir = mkdtempSync(join(tmpdir(), "cvt-scrub-"));
		try {
			const path = join(dir, "2026-11-08-daily-brief.md");
			writeFileSync(path, brief([ID]));
			assert.equal(scrubBriefs(db, dir), 0); // still published
			removePost(db, post.id, "asked");
			assert.equal(scrubBriefs(db, dir), 1);
			assert.ok(!readFileSync(path, "utf8").includes(ID));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("removing an unknown creator is an error, not a silent success", () => {
		assert.throws(() => removeCreator(seeded(), 9999, "x"), CreatorInputError);
	});
});
