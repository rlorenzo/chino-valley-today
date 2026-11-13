import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { createConnectApp } from "../connect/app.ts";
import { openDb } from "../db/index.ts";
import {
	CONNECT_CONSENT_NOTE,
	hasHashtag,
	pollConnections,
	saveConnection,
} from "./connections.ts";
import { listCreatorPosts, removeCreator } from "./store.ts";
import { type Fetch, seal, type Tokens, unseal } from "./tiktok-api.ts";

const cfg = {
	clientKey: "ck",
	clientSecret: "cs",
	redirectUri: "https://chinovalley.today/connect/tiktok/callback",
};
const key = randomBytes(32);
const NOW = new Date("2026-11-12T12:00:00Z");
const epoch = (iso: string) => Date.parse(iso) / 1000;

function tokens(over: Partial<Tokens> = {}): Tokens {
	return {
		openId: "open-1",
		accessToken: "access-1",
		accessExpiresAt: "2026-11-12T14:00:00.000Z",
		refreshToken: "refresh-1",
		refreshExpiresAt: "2027-05-01T00:00:00.000Z",
		scope: "user.info.basic,user.info.profile,video.list",
		...over,
	};
}

const user = { openId: "open-1", username: "ItsReallyTy1", displayName: "Ty" };

/** A fake TikTok: routes by path, records what was called. */
function fakeTikTok(
	routes: Record<string, (body: string) => [number, unknown]>,
) {
	const calls: string[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		calls.push(path);
		const [status, json] = routes[path](String(init?.body ?? ""));
		return new Response(JSON.stringify(json), { status });
	}) as Fetch;
	return { f, calls };
}

describe("tiktok connections", () => {
	test("exact hashtags only", () => {
		assert.ok(hasHashtag("Tacos! #ChinoHills #food", ["chinohills"]));
		assert.ok(!hasHashtag("#chinofood and chino", ["chino"]));
	});

	test("tokens are sealed at rest", () => {
		const s = seal(key, "secret");
		assert.ok(!s.includes("secret"));
		assert.equal(unseal(key, s), "secret");
		assert.throws(() => unseal(randomBytes(32), s));
	});

	test("connecting records consent and the poll queues only tagged posts", async () => {
		const db = openDb(":memory:");
		saveConnection(
			db,
			key,
			tokens({ accessExpiresAt: "2026-11-12T12:01:00Z" }),
			user,
			NOW,
		);
		const row = db.raw
			.prepare("SELECT * FROM creators WHERE handle = 'itsreallyty1'")
			.get() as { consent_at: string; consent_note: string };
		assert.equal(row.consent_at, "2026-11-12");
		assert.equal(row.consent_note, CONNECT_CONSENT_NOTE);
		const stored = db.raw
			.prepare("SELECT access_token FROM tiktok_connections")
			.get() as {
			access_token: string;
		};
		assert.ok(!stored.access_token.includes("access-1"));

		const { f, calls } = fakeTikTok({
			// Access token is about to expire, so the poll refreshes first.
			"/v2/oauth/token/": (body) => {
				assert.match(body, /grant_type=refresh_token/);
				assert.match(body, /refresh_token=refresh-1/);
				return [
					200,
					{
						access_token: "access-2",
						refresh_token: "refresh-2",
						open_id: "open-1",
						expires_in: 7200,
						refresh_expires_in: 15552000,
						scope: "video.list",
					},
				];
			},
			"/v2/video/list/": () => [
				200,
				{
					data: {
						videos: [
							{
								id: "7301234567890123456",
								create_time: epoch("2026-11-11T00:00:00Z"),
								video_description: "New boba spot #chino",
							},
							{
								id: "7301234567890123457",
								create_time: epoch("2026-11-10T00:00:00Z"),
								video_description: "Vacation #hawaii",
							},
							// Older than the 30-day first-poll window: never read.
							{
								id: "7301234567890123458",
								create_time: epoch("2026-09-01T00:00:00Z"),
								video_description: "#chino",
							},
						],
						cursor: 0,
						has_more: false,
					},
					error: { code: "ok" },
				},
			],
		});
		const r = await pollConnections(db, cfg, key, { fetchImpl: f, now: NOW });
		assert.deepEqual(r, { queued: 1, dropped: 0, failed: 0 });
		assert.deepEqual(calls, ["/v2/oauth/token/", "/v2/video/list/"]);
		const queued = listCreatorPosts(db, "queued");
		assert.equal(queued.length, 1);
		assert.equal(queued[0].origin, "api");
		assert.equal(queued[0].description, "");
		assert.equal(
			queued[0].url,
			"https://www.tiktok.com/@itsreallyty1/video/7301234567890123456",
		);

		// Rotated refresh token was stored, and a second poll does not duplicate.
		const again = await pollConnections(db, cfg, key, {
			fetchImpl: fakeTikTok({
				"/v2/video/list/": () => [
					200,
					{
						data: {
							videos: [
								{
									id: "7301234567890123456",
									create_time: epoch("2026-11-11T00:00:00Z"),
									video_description: "#chino",
								},
							],
							cursor: 0,
							has_more: false,
						},
						error: { code: "ok" },
					},
				],
			}).f,
			now: NOW,
		});
		assert.equal(again.queued, 0);
	});

	test("a revoked grant or a removed creator ends the connection", async () => {
		const db = openDb(":memory:");
		saveConnection(db, key, tokens(), user, NOW);
		const revoked = fakeTikTok({
			"/v2/video/list/": () => [
				401,
				{ error: { code: "access_token_invalid", message: "revoked" } },
			],
		});
		assert.equal(
			(await pollConnections(db, cfg, key, { fetchImpl: revoked.f, now: NOW }))
				.dropped,
			1,
		);

		const c = saveConnection(db, key, tokens(), user, NOW);
		const id = (
			db.raw
				.prepare("SELECT id FROM creators WHERE handle = ?")
				.get(c.handle) as { id: number }
		).id;
		removeCreator(db, id, "asked", NOW);
		const rev = fakeTikTok({ "/v2/oauth/revoke/": () => [200, {}] });
		assert.equal(
			(await pollConnections(db, cfg, key, { fetchImpl: rev.f, now: NOW }))
				.dropped,
			1,
		);
		assert.deepEqual(rev.calls, ["/v2/oauth/revoke/"]);
		assert.equal(
			db.raw.prepare("SELECT COUNT(*) AS n FROM tiktok_connections").get()?.n,
			0,
		);
	});

	test("callback refuses a state that does not match the cookie", async () => {
		const db = openDb(":memory:");
		const { f, calls } = fakeTikTok({});
		const app = createConnectApp(db, { cfg, key, fetchImpl: f });
		const start = await app.request(
			"https://chinovalley.today/connect/tiktok/start",
		);
		assert.equal(start.status, 302);
		const loc = new URL(start.headers.get("location") ?? "");
		assert.equal(
			loc.searchParams.get("scope"),
			"user.info.basic,user.info.profile,video.list",
		);
		const cookie = start.headers.get("set-cookie") ?? "";
		assert.match(cookie, /HttpOnly/i);

		const bad = await app.request(
			"https://chinovalley.today/connect/tiktok/callback?code=x&state=forged",
			{ headers: { cookie: cookie.split(";")[0] } },
		);
		assert.equal(bad.status, 400);
		assert.deepEqual(calls, []);
	});
});
