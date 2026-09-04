import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import { createApp } from "./app.ts";

// The dashboard binds loopback, but the operator reaches it through a browser
// over an SSH tunnel, so any page that browser visits can auto-submit a form
// to it. These pin the one thing standing between that form and a publish.
describe("admin CSRF", () => {
	const app = createApp(openDb(":memory:"));
	const form = (origin?: string) =>
		app.request("http://127.0.0.1:8788/posts/2026-09-03-some-slug/approve", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				host: "127.0.0.1:8788",
				...(origin ? { origin } : {}),
			},
			body: "ack=1",
		});

	test("a cross-origin form post is refused", async () => {
		assert.equal((await form("https://evil.example")).status, 403);
	});

	test("a form post with no Origin is refused", async () => {
		assert.equal((await form()).status, 403);
	});

	test("a same-origin form post reaches the route", async () => {
		const res = await form("http://127.0.0.1:8788");
		assert.notEqual(res.status, 403);
	});
});
