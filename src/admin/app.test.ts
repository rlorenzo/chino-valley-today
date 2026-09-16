import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDb } from "../db/index.ts";
import {
	createPost,
	getPost,
	type NewPost,
	TIER_C_ACK,
	type Tier,
	transitionPost,
} from "../pipeline/posts.ts";
import { ROOT } from "../store.ts";
import { createApp } from "./app.ts";

/**
 * A form POST at the dashboard. `origin` is left off to exercise the
 * Origin-less case the CSRF middleware also has to refuse.
 */
function formPost(
	app: ReturnType<typeof createApp>,
	slug: string,
	origin?: string,
	body = "ack=1",
) {
	return app.request(
		`http://127.0.0.1:8788/posts/${encodeURIComponent(slug)}/approve`,
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				host: "127.0.0.1:8788",
				...(origin ? { origin } : {}),
			},
			body,
		},
	);
}

// The dashboard binds loopback, but the operator reaches it through a browser
// over an SSH tunnel, so any page that browser visits can auto-submit a form
// to it. These pin the one thing standing between that form and a publish.
describe("admin CSRF", () => {
	const app = createApp(openDb(":memory:"));
	const form = (origin?: string) =>
		formPost(app, "2026-09-03-some-slug", origin);

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

// Approving a podcast is not the same as publishing one: the fixed intro and
// sign-off are spliced in and the audio rendered by the podcast job, so the
// dashboard hands it off rather than shipping a silent, intro-less draft.
describe("admin approve — podcast hand-off", () => {
	const SLUG_PREFIX = "admin-approve-test";

	function heldPost(
		db: ReturnType<typeof openDb>,
		name: string,
		postType: NewPost["postType"],
		tier: Tier = "B",
	): string {
		const slug = `${SLUG_PREFIX}-${name}`;
		createPost(db, {
			slug,
			postType,
			tier,
			title: `Title for ${name}`,
			bodyMd:
				"## Cold open\n\n**Maya:** A thing happened. [s](https://chino.gov/a)",
			sources: ["https://chino.gov/a"],
		});
		transitionPost(db, slug, "held", {
			heldReason:
				tier === "C"
					? "tierC: names a private individual"
					: "gate2: judge flagged tone",
		});
		return slug;
	}

	function cleanup(slug: string): void {
		for (const dir of ["queue", "published", "held"])
			rmSync(join(ROOT, "content", dir, `${slug}.md`), { force: true });
	}

	const approve = (app: ReturnType<typeof createApp>, slug: string) =>
		formPost(app, slug, "http://127.0.0.1:8788");

	test("a podcast stays held, marked for the render job", async () => {
		const db = openDb(":memory:");
		const slug = heldPost(db, "episode", "podcast");
		try {
			const res = await approve(createApp(db), slug);
			assert.equal(res.status, 303);
			const row = getPost(db, slug);
			assert.equal(row?.status, "held");
			// The prefix is the resume contract read by src/podcast/run.ts.
			assert.ok(
				row?.held_reason?.startsWith("audio:approved"),
				`held_reason was ${row?.held_reason}`,
			);
			assert.equal(row?.published_at, null);
		} finally {
			cleanup(slug);
		}
	});

	// The judge escalates a flagged episode to Tier C, so this branch is
	// reachable — and the acknowledgment marker is the only durable record
	// that a human ticked the box before the render job publishes it.
	test("an approved Tier C podcast records the acknowledgment", async () => {
		const db = openDb(":memory:");
		const slug = heldPost(db, "tierc-episode", "podcast", "C");
		try {
			assert.equal((await approve(createApp(db), slug)).status, 303);
			const row = getPost(db, slug);
			assert.equal(row?.status, "held");
			assert.ok(
				row?.held_reason?.startsWith("audio:approved"),
				`held_reason was ${row?.held_reason}`,
			);
			assert.ok(
				row?.held_reason?.endsWith(TIER_C_ACK),
				`held_reason was ${row?.held_reason}`,
			);
		} finally {
			cleanup(slug);
		}
	});

	// Server-side enforcement of the Tier C rule: the HTML `required`
	// attribute is bypassed entirely by a raw form POST.
	test("a Tier C podcast with no acknowledgment is refused", async () => {
		const db = openDb(":memory:");
		const slug = heldPost(db, "tierc-noack", "podcast", "C");
		try {
			const res = await formPost(
				createApp(db),
				slug,
				"http://127.0.0.1:8788",
				"",
			);
			assert.equal(res.status, 400);
			assert.equal(
				getPost(db, slug)?.held_reason,
				"tierC: names a private individual",
			);
		} finally {
			cleanup(slug);
		}
	});

	test("every other post type still publishes straight away", async () => {
		const db = openDb(":memory:");
		const slug = heldPost(db, "recap", "meeting_recap");
		try {
			const res = await approve(createApp(db), slug);
			assert.equal(res.status, 303);
			const row = getPost(db, slug);
			assert.equal(row?.status, "published");
			assert.equal(row?.published_via, "manual");
			assert.ok(row?.held_reason?.startsWith("reviewed:approved"));
		} finally {
			cleanup(slug);
		}
	});
});
