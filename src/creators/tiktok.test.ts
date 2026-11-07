import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type FetchLike,
	normalizeHandle,
	parseTikTokUrl,
	resolveShortLink,
} from "./tiktok.ts";

const ID = "7301234567890123456";

describe("parseTikTokUrl", () => {
	test("a full video link is canonicalized, tracking params dropped", () => {
		const r = parseTikTokUrl(
			`https://www.tiktok.com/@ItsReallyTy1/video/${ID}?is_from_webapp=1&sender_device=pc&_r=1`,
		);
		assert.deepEqual(r, {
			kind: "video",
			ref: {
				handle: "itsreallyty1",
				videoId: ID,
				url: `https://www.tiktok.com/@itsreallyty1/video/${ID}`,
			},
		});
	});

	test("bare and mobile hosts are accepted", () => {
		for (const host of ["tiktok.com", "m.tiktok.com"]) {
			const r = parseTikTokUrl(`https://${host}/@a.b_c/video/${ID}`);
			assert.equal(r.kind, "video");
		}
	});

	test("share short links are recognized for resolving", () => {
		assert.deepEqual(parseTikTokUrl("https://vm.tiktok.com/ZMabc123/"), {
			kind: "short",
			url: "https://vm.tiktok.com/ZMabc123/",
		});
		assert.deepEqual(parseTikTokUrl("https://www.tiktok.com/t/ZTabc123/"), {
			kind: "short",
			url: "https://www.tiktok.com/t/ZTabc123/",
		});
	});

	test("a profile link gets a pointed error, not a generic one", () => {
		const r = parseTikTokUrl(
			"https://www.tiktok.com/@itsreallyty1?_r=1&_t=ZP-9BBzic4GHYU",
		);
		assert.equal(r.kind, "error");
		assert.match(r.kind === "error" ? r.reason : "", /profile link/);
	});

	test("photo posts are refused: the embed player plays videos", () => {
		const r = parseTikTokUrl(`https://www.tiktok.com/@a1/photo/${ID}`);
		assert.equal(r.kind, "error");
		assert.match(r.kind === "error" ? r.reason : "", /photo post/);
	});

	test("lookalike hosts and non-links are refused", () => {
		for (const bad of [
			`https://www.tiktok.com.evil.example/@a1/video/${ID}`,
			`https://eviltiktok.com/@a1/video/${ID}`,
			`javascript:alert(1)`,
			"not a url",
			`https://www.tiktok.com/@a1/video/123`,
		]) {
			assert.equal(parseTikTokUrl(bad).kind, "error", bad);
		}
	});
});

describe("normalizeHandle", () => {
	test("strips the @ and lowercases", () => {
		assert.equal(normalizeHandle(" @ItsReallyTy1 "), "itsreallyty1");
	});
	test("refuses characters TikTok does not allow", () => {
		assert.equal(normalizeHandle("bad handle"), null);
		assert.equal(normalizeHandle("<script>"), null);
		assert.equal(normalizeHandle("a"), null);
	});
});

function fakeFetch(
	hops: Record<string, { status: number; location?: string }>,
): FetchLike & { calls: string[] } {
	const calls: string[] = [];
	const f = (async (
		url: string,
		init: { method: string; redirect: string },
	) => {
		calls.push(url);
		assert.equal(init.redirect, "manual");
		assert.equal(init.method, "HEAD");
		const hop = hops[url];
		if (!hop) throw new Error(`unexpected fetch ${url}`);
		return {
			status: hop.status,
			headers: {
				get: (n: string) => (n === "location" ? (hop.location ?? null) : null),
			},
		};
	}) as unknown as FetchLike & { calls: string[] };
	f.calls = calls;
	return f;
}

describe("resolveShortLink", () => {
	test("follows redirects to the video, reading headers only", async () => {
		const f = fakeFetch({
			"https://vm.tiktok.com/ZMabc/": {
				status: 301,
				location: "https://www.tiktok.com/t/ZTxyz/",
			},
			"https://www.tiktok.com/t/ZTxyz/": {
				status: 302,
				location: `https://www.tiktok.com/@itsreallyty1/video/${ID}?_r=1`,
			},
		});
		const r = await resolveShortLink("https://vm.tiktok.com/ZMabc/", f);
		assert.equal(r.kind, "video");
		assert.equal(r.kind === "video" ? r.ref.handle : "", "itsreallyty1");
		assert.equal(f.calls.length, 2);
	});

	test("a deleted video's link lands on the home page and is reported", async () => {
		const f = fakeFetch({
			"https://vm.tiktok.com/ZMgone/": {
				status: 302,
				location: "https://www.tiktok.com/?_r=1",
			},
		});
		const r = await resolveShortLink("https://vm.tiktok.com/ZMgone/", f);
		assert.equal(r.kind, "error");
	});

	test("a redirect off TikTok is refused", async () => {
		const f = fakeFetch({
			"https://vm.tiktok.com/ZMx/": {
				status: 302,
				location: `https://evil.example/@a1/video/${ID}`,
			},
		});
		assert.equal(
			(await resolveShortLink("https://vm.tiktok.com/ZMx/", f)).kind,
			"error",
		);
	});

	test("a network failure is an error, not a throw", async () => {
		const f = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as FetchLike;
		assert.equal(
			(await resolveShortLink("https://vm.tiktok.com/ZMx/", f)).kind,
			"error",
		);
	});
});
