import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Db, openDb } from "../db/index.ts";
import {
	generateNixleReleases,
	mentionsMinor,
	stripMailPreamble,
	stripPriorityPrefix,
} from "./nixle-releases.ts";

const NOW = new Date("2026-08-17T12:00:00.000Z");

let hashCounter = 0;
function addRelease(
	db: Db,
	opts: {
		title: string;
		body: string;
		occurredAt: string;
		chinoRelevant: boolean;
		channelSlug?: string;
	},
): void {
	const sourceId = db.upsertSource({
		key: "sbsheriff-nixle-mail",
		name: "nixle",
		base_url: "https://local.nixle.com/",
		method: "email",
	});
	const hash = String(hashCounter++).padStart(64, "0");
	const code = `1260${hash.slice(-4)}`;
	const doc = db.insertDocument({
		source_id: sourceId,
		url: `https://local.nixle.com/alert/${code}/`,
		doc_type: "news_release",
		title: opts.title,
		content_hash: hash,
		raw_path: `data/raw/00/${hash}.eml`,
	}).id;
	db.insertItem({
		document_id: doc,
		source_url: `https://local.nixle.com/alert/${code}/`,
		item_type: "news_release",
		external_id: code,
		title: opts.title,
		body: opts.body,
		occurred_at: opts.occurredAt,
		meta: {
			chinoRelevant: opts.chinoRelevant,
			channelSlug: opts.channelSlug ?? "sbsd---chino-hills-police-department",
			priority: "advisory",
			tier: "C",
		},
	});
}

// This source auto-publishes without human review (EDITORIAL.md "Agency alert
// channels", 2026-08-17), so the minors guard is the only editorial check
// between the archive and a published name. It has to catch minors AND stay off
// adult releases — a guard that holds everything would silently undo the
// auto-publish decision. Both halves are asserted.

describe("minors guard", () => {
	test("holds the phrasings Sheriff releases use for minors", () => {
		for (const s of [
			"The victim, a 15-year-old female, was transported",
			"A juvenile was detained at the scene",
			"Deputies located the missing child",
			"The suspect is a 16 year old resident of Chino",
			"the teen was released to a parent",
			"A minor was present in the vehicle",
			"the boy was found safe",
			"Two juveniles were interviewed",
			"the incident occurred near Chino High School",
		]) {
			assert.ok(mentionsMinor(s), `should have held: ${s}`);
		}
	});

	test("does not hold ordinary adult release text", () => {
		for (const s of [
			"Deputies served a search warrant in the 300 block of King Street, Chino",
			"The suspect, a 40-year-old resident of Highland, was booked",
			"A 22 year old man was arrested following the collision",
			"A traffic collision investigation is ongoing on Grand Ave",
			"The 18-year-old driver was cited and released",
		]) {
			assert.ok(!mentionsMinor(s), `should NOT have held: ${s}`);
		}
	});

	test("does not hold on local place names that contain minors vocabulary", () => {
		// Boys Republic is a real Chino Hills institution with a street named
		// after it, so this collision lands squarely on our coverage area.
		for (const s of [
			"Deputies are investigating a collision on Grand Ave between Peyton Dr and Boys Republic Dr",
			"The incident occurred near the Boys & Girls Club on Riverside Dr",
			"A report was taken at the Boys and Girls Club",
		]) {
			assert.ok(!mentionsMinor(s), `should NOT have held: ${s}`);
		}
	});

	test("still holds a minor mentioned alongside a scrubbed place name", () => {
		assert.ok(
			mentionsMinor(
				"A 15-year-old was located near Boys Republic Dr and returned home",
			),
		);
		assert.ok(
			mentionsMinor("The juvenile was last seen at the Boys & Girls Club"),
		);
	});

	test("holds when a minor appears alongside an adult", () => {
		assert.ok(
			mentionsMinor(
				"The driver, a 34-year-old man, and a 9-year-old passenger were transported",
			),
		);
	});
});

describe("title and body cleanup", () => {
	test("strips the Nixle priority prefix in both observed forms", () => {
		assert.equal(
			stripPriorityPrefix("Advisory Message: Deputy Involved Shooting Occurs"),
			"Deputy Involved Shooting Occurs",
		);
		assert.equal(
			stripPriorityPrefix("Alert: Evacuation ordered"),
			"Evacuation ordered",
		);
		assert.equal(stripPriorityPrefix("No prefix here"), "No prefix here");
	});

	test("drops the mailing-list preamble but keeps the release", () => {
		const body = [
			"Dear Nixle User,",
			"",
			"Advisory Message has been issued by the SBSD - Chino Hills Police Department.",
			"",
			"Friday August 14, 2026 4:25 PM PDT",
			"",
			"DATE: August 14, 2026, at about 10:50 a.m.",
			"",
			"SUMMARY: Deputies responded to a call in Chino Hills.",
		].join("\n");
		const out = stripMailPreamble(body);
		assert.ok(!out.includes("Dear Nixle User"));
		assert.ok(!out.includes("has been issued by"));
		assert.ok(out.startsWith("DATE: August 14"));
		assert.ok(out.includes("SUMMARY: Deputies responded"));
	});

	test("leaves an unrecognized body untouched", () => {
		const body = "A release in some future template shape.";
		assert.equal(stripMailPreamble(body), body);
	});
});

describe("generateNixleReleases", () => {
	test("publishes a Chino-relevant release as headline plus link, never body", () => {
		const db = openDb(":memory:");
		addRelease(db, {
			title: "Advisory Message: Deputies Investigate Collision on Grand Ave",
			body: [
				"Dear Nixle User,",
				"",
				"Advisory Message has been issued by the SBSD - Chino Hills Police Department.",
				"",
				"DATE: August 16, 2026, at about 9:15 a.m.",
				"",
				"SUMMARY: Deputies responded to a collision in Chino Hills. The driver, a 45-year-old resident, was cited.",
				"",
				// The real footer of every Nixle message. It carries the mailbox
				// address and a live subscription token, which is why body text
				// must never reach a published post.
				"To manage your email settings, please log into your account at https://local.nixle.com/settings/subscription/00000/fixture%2Balerts%40example%2Etest/0000000000000000000000000000dead/?pub_id=00000000.",
			].join("\n"),
			occurredAt: "2026-08-16T16:15:00.000Z",
			chinoRelevant: true,
		});

		const { posts } = generateNixleReleases(db, NOW);
		assert.equal(posts.length, 1);
		const p = posts[0];
		assert.equal(p.tier, "A");
		assert.equal(p.postType, "alert");
		assert.equal(p.title, "Deputies Investigate Collision on Grand Ave");
		assert.match(
			p.bodyMd,
			/\[Read the full release \(Nixle\)\]\(https:\/\/local\.nixle\.com\/alert\/\d+\/\)/,
		);
		assert.equal(p.sources.length, 1);

		// No release text, ever.
		assert.ok(!p.bodyMd.includes("DATE: August 16"));
		assert.ok(!p.bodyMd.includes("45-year-old"));
		assert.ok(!p.bodyMd.includes("Dear Nixle User"));
		// And specifically none of the credential material in the footer.
		assert.ok(!p.bodyMd.includes("fixture%2Balerts"));
		assert.ok(!p.bodyMd.includes("0000000000000000000000000000dead"));
		assert.ok(!p.bodyMd.includes("settings/subscription"));
	});

	test("does not publish county-wide releases about other cities", () => {
		const db = openDb(":memory:");
		addRelease(db, {
			title: "Advisory Message: Deputy Involved Shooting Occurs in Mentone",
			body: "LOCATION: 300 Block of King Street, Mentone, CA",
			occurredAt: "2026-08-16T16:15:00.000Z",
			chinoRelevant: false,
			channelSlug: "sbsd---headquarters",
		});
		const { posts, notes } = generateNixleReleases(db, NOW);
		assert.equal(posts.length, 0);
		assert.match(notes[0], /1 not Chino-relevant/);
	});

	test("a Chino release involving a minor is HELD, not dropped", () => {
		const db = openDb(":memory:");
		addRelease(db, {
			title: "Advisory Message: Missing Juvenile Located in Chino",
			body: "SUMMARY: A 14-year-old was reported missing in Chino and later located safe.",
			occurredAt: "2026-08-16T16:15:00.000Z",
			chinoRelevant: true,
		});
		const { posts, notes } = generateNixleReleases(db, NOW);
		// The post MUST still be produced. Skipping it is what made the hold
		// invisible: the dashboard's held queue reads posts, so no post row meant
		// nothing to review, and the note pointed at an empty queue.
		assert.equal(posts.length, 1);
		assert.ok(posts[0].heldReason, "held post must carry a heldReason");
		assert.match(posts[0].heldReason, /minors guard/);
		assert.equal(posts[0].tier, "C");
		assert.match(notes[0], /1 to the held queue/);
		assert.match(notes[1], /HELD for human review in the admin dashboard/);
	});

	test("a publishable release carries no heldReason and stays Tier A", () => {
		const db = openDb(":memory:");
		addRelease(db, {
			title: "Advisory Message: Collision on Grand Ave in Chino Hills",
			body: "SUMMARY: An adult driver was cited.",
			occurredAt: "2026-08-16T16:15:00.000Z",
			chinoRelevant: true,
		});
		const { posts } = generateNixleReleases(db, NOW);
		assert.equal(posts.length, 1);
		assert.equal(posts[0].heldReason, undefined);
		assert.equal(posts[0].tier, "A");
	});

	test("does not publish releases older than the recency window", () => {
		const db = openDb(":memory:");
		addRelease(db, {
			title: "Advisory Message: Old collision in Chino",
			body: "SUMMARY: An adult driver was cited.",
			occurredAt: "2026-06-01T16:15:00.000Z",
			chinoRelevant: true,
		});
		const { posts, notes } = generateNixleReleases(db, NOW);
		assert.equal(posts.length, 0);
		assert.match(notes[0], /1 older than 30 days/);
	});

	test("slugs are stable across runs so re-running never duplicates a post", () => {
		const db = openDb(":memory:");
		addRelease(db, {
			title: "Advisory Message: Collision on Grand Ave in Chino Hills",
			body: "SUMMARY: An adult driver was cited.",
			occurredAt: "2026-08-16T16:15:00.000Z",
			chinoRelevant: true,
		});
		const a = generateNixleReleases(db, NOW).posts[0].slug;
		const b = generateNixleReleases(db, new Date("2026-08-17T23:00:00.000Z"))
			.posts[0].slug;
		assert.equal(a, b);
	});
});
