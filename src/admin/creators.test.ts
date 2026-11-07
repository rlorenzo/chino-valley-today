import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { listCreatorPosts, listCreators } from "../creators/store.ts";
import type { FetchLike } from "../creators/tiktok.ts";
import { openDb } from "../db/index.ts";
import { createApp } from "./app.ts";

const ORIGIN = "http://127.0.0.1:8788";
const ID = "7301234567890123456";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(fetchImpl?: FetchLike) {
	const db = openDb(":memory:");
	const creatorsDir = mkdtempSync(join(tmpdir(), "cvt-admin-creators-"));
	dirs.push(creatorsDir);
	const app = createApp(db, { creatorsDir, fetchImpl });
	const post = (
		path: string,
		fields: Record<string, string>,
		origin = ORIGIN,
	) =>
		app.request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				host: "127.0.0.1:8788",
				origin,
			},
			body: new URLSearchParams(fields).toString(),
		});
	return { db, app, post, creatorsDir };
}

const TY = {
	handle: "@itsreallyty1",
	display_name: "Ty",
	covers: "Food in Chino",
	consent_at: "2026-11-07",
	consent_note: "DM reply",
};

describe("admin: local creators", () => {
	test("adding a creator, then a post, publishes the site data", async () => {
		const { db, post, creatorsDir } = setup();
		assert.equal((await post("/creators", TY)).status, 303);
		const res = await post("/creators/posts", {
			url: `https://www.tiktok.com/@itsreallyty1/video/${ID}?_r=1`,
			description: "A tour of the new taco spot on Riverside",
			ack: "1",
		});
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/#creators");
		assert.equal(listCreatorPosts(db, "published").length, 1);
		const videos = JSON.parse(
			readFileSync(join(creatorsDir, "videos.json"), "utf8"),
		);
		assert.equal(
			videos[0].url,
			`https://www.tiktok.com/@itsreallyty1/video/${ID}`,
		);
		assert.equal(
			videos[0].description,
			"A tour of the new taco spot on Riverside",
		);
	});

	test("the review acknowledgment is enforced server-side", async () => {
		const { db, post } = setup();
		await post("/creators", TY);
		const res = await post("/creators/posts", {
			url: `https://www.tiktok.com/@itsreallyty1/video/${ID}`,
			description: "Tacos",
		});
		assert.equal(res.status, 400);
		assert.match(await res.text(), /review box/);
		assert.equal(listCreatorPosts(db, "published").length, 0);
	});

	test("a profile link is refused with a readable reason", async () => {
		const { post } = setup();
		await post("/creators", TY);
		const res = await post("/creators/posts", {
			url: "https://www.tiktok.com/@itsreallyty1?_r=1&_t=ZP-9BBzic4GHYU",
			description: "x",
			ack: "1",
		});
		assert.equal(res.status, 400);
		assert.match(await res.text(), /profile link/);
	});

	test("a share short link is resolved through its redirect", async () => {
		const fetchImpl = (async () => ({
			status: 301,
			headers: {
				get: (n: string) =>
					n === "location"
						? `https://www.tiktok.com/@itsreallyty1/video/${ID}?_r=1`
						: null,
			},
		})) as unknown as FetchLike;
		const { db, post } = setup(fetchImpl);
		await post("/creators", TY);
		const res = await post("/creators/posts", {
			url: "https://vm.tiktok.com/ZMabc123/",
			description: "Tacos",
			ack: "1",
		});
		assert.equal(res.status, 303);
		assert.equal(listCreatorPosts(db, "published")[0].video_id, ID);
	});

	test("remove takes a post off and republishes", async () => {
		const { db, post, creatorsDir } = setup();
		await post("/creators", TY);
		await post("/creators/posts", {
			url: `https://www.tiktok.com/@itsreallyty1/video/${ID}`,
			description: "Tacos",
			ack: "1",
		});
		const id = listCreatorPosts(db, "published")[0].id;
		assert.equal(
			(await post(`/creators/posts/${id}/remove`, { reason: "asked" })).status,
			303,
		);
		assert.deepEqual(
			JSON.parse(readFileSync(join(creatorsDir, "videos.json"), "utf8")),
			[],
		);
	});

	test("a cross-origin form post cannot feature anything", async () => {
		const { db, post } = setup();
		const res = await post("/creators", TY, "https://evil.example");
		assert.equal(res.status, 403);
		assert.equal(listCreators(db).length, 0);
	});

	test("the dashboard shows the section and escapes what it renders", async () => {
		const { app, post } = setup();
		await post("/creators", {
			...TY,
			display_name: "<b>Ty</b>",
		});
		const html = await (await app.request(`${ORIGIN}/`)).text();
		assert.match(html, /id="creators"/);
		assert.match(html, /&lt;b&gt;Ty&lt;\/b&gt;/);
		assert.doesNotMatch(html, /<b>Ty<\/b>/);
	});
});
