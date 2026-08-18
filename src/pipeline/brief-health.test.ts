import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import {
	checkBriefDatabase,
	checkBriefHttp,
	expectedBriefSlug,
	staleHealthText,
	verifyBriefHealth,
} from "./brief-health.ts";

describe("expectedBriefSlug", () => {
	test("names today's brief by the LA calendar day, not the UTC day", () => {
		// 08:00 PDT on Aug 18 is already Aug 19 in UTC by evening standards —
		// the watchdog must still expect the Aug 18 brief.
		assert.equal(
			expectedBriefSlug(new Date("2026-08-18T15:00:00.000Z")),
			"2026-08-18-daily-brief",
		);
		// 11 PM PDT Aug 18 = Aug 19 UTC: still the Aug 18 brief.
		assert.equal(
			expectedBriefSlug(new Date("2026-08-19T06:00:00.000Z")),
			"2026-08-18-daily-brief",
		);
	});
});

describe("staleHealthText", () => {
	const built = [
		"ok",
		"built=2026-08-18T13:00:00.000Z",
		"posts=10",
		"latest_post=2026-08-17",
		"latest_brief=2026-08-17",
		"pipeline=fresh",
		"",
	].join("\n");

	test("flips fresh to stale and touches nothing else", () => {
		const flipped = staleHealthText(built);
		assert.ok(flipped);
		assert.match(flipped, /^ok\n/);
		assert.match(flipped, /pipeline=stale/);
		assert.doesNotMatch(flipped, /pipeline=fresh/);
		assert.equal(flipped.split("\n").length, built.split("\n").length);
	});

	test("nothing to write when the marker is already stale or absent", () => {
		assert.equal(staleHealthText(built.replace("fresh", "stale")), null);
		assert.equal(staleHealthText("ok\nbuilt=whenever\n"), null);
	});
});

describe("checkBriefDatabase", () => {
	const NOW = new Date("2026-08-18T15:00:00.000Z");

	test("passes when today's brief exists with published status", () => {
		const db = openDb(":memory:");
		db.raw
			.prepare(
				`INSERT INTO posts (slug, post_type, tier, status, file_path, created_at)
         VALUES ('2026-08-18-daily-brief', 'daily-brief', 'A', 'published', 'content/published/2026-08-18-daily-brief.md', '2026-08-18T13:00:00.000Z')`,
			)
			.run();

		const res = checkBriefDatabase(db, NOW);
		assert.equal(res.ok, true);
		assert.equal(res.status, "published");
		assert.equal(res.slug, "2026-08-18-daily-brief");
	});

	test("fails when post is absent or not published", () => {
		const db = openDb(":memory:");
		const resAbsent = checkBriefDatabase(db, NOW);
		assert.equal(resAbsent.ok, false);
		assert.equal(resAbsent.status, "absent");

		db.raw
			.prepare(
				`INSERT INTO posts (slug, post_type, tier, status, file_path, created_at)
         VALUES ('2026-08-18-daily-brief', 'daily-brief', 'A', 'queued', 'content/queued/2026-08-18-daily-brief.md', '2026-08-18T13:00:00.000Z')`,
			)
			.run();
		const resQueued = checkBriefDatabase(db, NOW);
		assert.equal(resQueued.ok, false);
		assert.equal(resQueued.status, "queued");
	});
});

describe("checkBriefHttp", () => {
	test("passes when HTTP 200 response contains brief markup", async () => {
		const mockFetch = (async () =>
			new Response(
				"<html><head><title>Daily Brief — August 18, 2026</title></head><body><h1>Daily Brief</h1></body></html>",
				{ status: 200 },
			)) as unknown as typeof fetch;

		const res = await checkBriefHttp("2026-08-18", {
			baseUrl: "http://example.test",
			fetchFn: mockFetch,
		});
		assert.equal(res.ok, true);
		assert.equal(res.status, 200);
	});

	test("fails when HTTP endpoint returns 404 or 500", async () => {
		const mockFetch404 = (async () =>
			new Response("Not found", { status: 404 })) as unknown as typeof fetch;
		const res404 = await checkBriefHttp("2026-08-18", {
			baseUrl: "http://example.test",
			fetchFn: mockFetch404,
		});
		assert.equal(res404.ok, false);
		assert.equal(res404.status, 404);

		const mockFetch500 = (async () =>
			new Response("Server Error", { status: 500 })) as unknown as typeof fetch;
		const res500 = await checkBriefHttp("2026-08-18", {
			baseUrl: "http://example.test",
			fetchFn: mockFetch500,
		});
		assert.equal(res500.ok, false);
		assert.equal(res500.status, 500);
	});

	test("fails on network failure or timeout", async () => {
		const mockFetchThrow = (async () => {
			throw new Error("Connection timed out after 10000ms");
		}) as unknown as typeof fetch;

		const res = await checkBriefHttp("2026-08-18", {
			baseUrl: "http://example.test",
			fetchFn: mockFetchThrow,
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /Connection timed out/);
	});

	test("fails when HTTP 200 response is missing brief content markers", async () => {
		const mockFetchEmpty = (async () =>
			new Response("<html><body>Placeholder page</body></html>", {
				status: 200,
			})) as unknown as typeof fetch;

		const res = await checkBriefHttp("2026-08-18", {
			baseUrl: "http://example.test",
			fetchFn: mockFetchEmpty,
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /missing brief content markers/);
	});
});

describe("verifyBriefHealth", () => {
	const NOW = new Date("2026-08-18T15:00:00.000Z");

	function createDb(withPublished = true) {
		const db = openDb(":memory:");
		if (withPublished) {
			db.raw
				.prepare(
					`INSERT INTO posts (slug, post_type, tier, status, file_path, created_at)
           VALUES ('2026-08-18-daily-brief', 'daily-brief', 'A', 'published', 'content/published/2026-08-18-daily-brief.md', '2026-08-18T13:00:00.000Z')`,
				)
				.run();
		}
		return db;
	}

	test("healthy when DB post is published and HTTP endpoint returns 200 with content", async () => {
		const db = createDb(true);
		const mockFetch = (async () =>
			new Response("<h1>Daily Brief — 2026-08-18</h1>", {
				status: 200,
			})) as unknown as typeof fetch;

		const res = await verifyBriefHealth(db, NOW, {
			baseUrl: "http://example.test",
			fetchFn: mockFetch,
		});
		assert.equal(res.healthy, true);
		assert.equal(res.dbOk, true);
		assert.equal(res.httpOk, true);
		assert.equal(res.error, undefined);
	});

	test("unhealthy when DB post is published but HTTP returns 404 or 500", async () => {
		const db = createDb(true);
		const mockFetch = (async () =>
			new Response("Not found", { status: 404 })) as unknown as typeof fetch;

		const res = await verifyBriefHealth(db, NOW, {
			baseUrl: "http://example.test",
			fetchFn: mockFetch,
		});
		assert.equal(res.healthy, false);
		assert.equal(res.dbOk, true);
		assert.equal(res.httpOk, false);
		assert.match(res.error ?? "", /http delivery check failed/);
	});

	test("unhealthy when DB post is published but HTTP times out", async () => {
		const db = createDb(true);
		const mockFetch = (async () => {
			throw new Error("timeout");
		}) as unknown as typeof fetch;

		const res = await verifyBriefHealth(db, NOW, {
			baseUrl: "http://example.test",
			fetchFn: mockFetch,
		});
		assert.equal(res.healthy, false);
		assert.equal(res.dbOk, true);
		assert.equal(res.httpOk, false);
	});

	test("unhealthy when DB post is missing even if HTTP returns 200", async () => {
		const db = createDb(false);
		const mockFetch = (async () =>
			new Response("<h1>Daily Brief — 2026-08-18</h1>", {
				status: 200,
			})) as unknown as typeof fetch;

		const res = await verifyBriefHealth(db, NOW, {
			baseUrl: "http://example.test",
			fetchFn: mockFetch,
		});
		assert.equal(res.healthy, false);
		assert.equal(res.dbOk, false);
		assert.equal(res.httpOk, true);
		assert.match(res.error ?? "", /database check failed/);
	});
});
