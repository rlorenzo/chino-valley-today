// The dashboard's "Local creators" section: the creators list, the paste-a-
// link form, the review queue the creator-authorized TikTok path will fill,
// and removal. EDITORIAL.md "Local creators" is the policy; src/creators/ is
// the state. Every change rewrites content/creators/*.json, which the next
// site rebuild publishes.
import type { Context, Hono } from "hono";
import { writeCreatorsFiles } from "../creators/export.ts";
import {
	addCreator,
	addManualPost,
	approveQueuedPost,
	COVERS_MAX,
	CREATOR_POST_ACK,
	CreatorInputError,
	DESCRIPTION_MAX,
	listCreatorPosts,
	listCreators,
	rejectQueuedPost,
	removeCreator,
	removePost,
} from "../creators/store.ts";
import {
	type FetchLike,
	parseTikTokUrl,
	profileUrl,
	resolveShortLink,
} from "../creators/tiktok.ts";
import type { Db } from "../db/index.ts";
import { esc, layout } from "./render.ts";

export interface CreatorRouteOptions {
	/** Where the site's creator JSON is written. Tests point this at a temp dir. */
	creatorsDir?: string;
	/** Used only to follow a share short link's redirect. */
	fetchImpl?: FetchLike;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function day(iso: string | null): string {
	return iso ? esc(iso.slice(0, 10)) : '<span class="muted">—</span>';
}

const ACK_CHECKBOX = `<label class="ack"><input type="checkbox" name="ack" value="1" required> ${esc(CREATOR_POST_ACK)}</label>`;

export function renderCreatorsSection(db: Db): string {
	const creators = listCreators(db);
	const queued = listCreatorPosts(db, "queued");
	const published = listCreatorPosts(db, "published");

	const addPost =
		creators.length === 0
			? '<p class="muted">Add a creator below before featuring a post.</p>'
			: `<form method="post" action="/creators/posts" class="card">
        <h3>Feature a TikTok post</h3>
        <label>Video link <input type="text" name="url" required placeholder="https://www.tiktok.com/@handle/video/… or a vm.tiktok.com share link"></label>
        <label>One line, in your own words (${DESCRIPTION_MAX} characters max; this is what readers see)
          <input type="text" name="description" required maxlength="${DESCRIPTION_MAX}" placeholder="A tour of the new taco spot on Riverside Drive"></label>
        ${ACK_CHECKBOX}
        <p class="muted">Skip any video where a child is the focus, or a private person is shown in a way they might mind. It appears on /creators/ and in the next morning's brief.</p>
        <button type="submit" class="approve">Feature it</button>
      </form>`;

	const queue =
		queued.length === 0
			? ""
			: `<h3>Waiting for review</h3>${queued
					.map(
						(
							p,
						) => `<form method="post" action="/creators/posts/${p.id}/approve" class="card">
        <p><b>${esc(p.display_name)}</b> (<a href="${esc(p.url)}" rel="noopener noreferrer">@${esc(p.handle)} on TikTok</a>) · found ${day(p.added_at)}</p>
        <label>One line, in your own words <input type="text" name="description" required maxlength="${DESCRIPTION_MAX}" value="${esc(p.description)}"></label>
        ${ACK_CHECKBOX}
        <div class="actions">
          <button type="submit" class="approve">Approve</button>
          <button type="submit" class="reject" formaction="/creators/posts/${p.id}/reject" formnovalidate>Reject</button>
        </div>
      </form>`,
					)
					.join("\n")}`;

	const featured =
		published.length === 0
			? '<p class="muted">No posts featured yet.</p>'
			: `<table><tr><th>Featured</th><th>Creator</th><th>Description</th><th>Video</th><th></th></tr>${published
					.map(
						(p) => `<tr>
        <td>${day(p.published_at)}</td>
        <td>${esc(p.display_name)} <span class="muted">@${esc(p.handle)}</span></td>
        <td>${esc(p.description)}</td>
        <td><a href="${esc(p.url)}" rel="noopener noreferrer">open</a></td>
        <td><form method="post" action="/creators/posts/${p.id}/remove" class="actions">
          <input type="text" name="reason" placeholder="why (e.g. creator asked)">
          <button type="submit" class="reject">Remove</button>
        </form></td>
      </tr>`,
					)
					.join("")}</table>`;

	const list =
		creators.length === 0
			? '<p class="muted">No creators yet.</p>'
			: `<table><tr><th>Creator</th><th>Covers</th><th>Consent</th><th></th></tr>${creators
					.map(
						(c) => `<tr>
        <td>${esc(c.display_name)} <a href="${esc(profileUrl(c.handle))}" rel="noopener noreferrer">@${esc(c.handle)}</a></td>
        <td>${c.covers ? esc(c.covers) : '<span class="muted">—</span>'}</td>
        <td>${
					c.consent_at
						? `<span class="badge badge-pass">yes</span> ${esc(c.consent_at)}${c.consent_note ? ` <span class="muted">${esc(c.consent_note)}</span>` : ""}`
						: '<span class="badge badge-warn">not yet</span> <span class="muted">posts can be featured; no profile on /creators/</span>'
				}</td>
        <td><form method="post" action="/creators/${c.id}/remove" class="actions">
          <input type="text" name="reason" placeholder="why (e.g. asked to be removed)">
          <button type="submit" class="reject">Remove creator</button>
        </form></td>
      </tr>`,
					)
					.join("")}</table>`;

	const addCreatorForm = `<form method="post" action="/creators" class="card">
    <h3>Add a creator</h3>
    <label>TikTok username <input type="text" name="handle" required placeholder="@itsreallyty1"></label>
    <label>Display name <input type="text" name="display_name" required></label>
    <label>What they cover (${COVERS_MAX} characters max) <input type="text" name="covers" maxlength="${COVERS_MAX}" placeholder="Food and new businesses in Chino"></label>
    <label>Date they agreed to be featured (leave empty if you have not asked) <input type="date" name="consent_at"></label>
    <label>How they agreed <input type="text" name="consent_note" placeholder="Replied yes to a DM"></label>
    <button type="submit">Add creator</button>
  </form>`;

	return `<p class="muted">Hand-picked TikTok posts about the Chino Valley. Readers see your one-line description and a click-to-play card; nothing loads from TikTok until they press play. Changes reach the site at the next rebuild (after the morning brief).</p>
  ${addPost}
  ${queue}
  <h3>Featured</h3>
  ${featured}
  <h3>Creators</h3>
  ${list}
  ${addCreatorForm}`;
}

function inputError(message: string): string {
	return layout(
		"Could not save — Chino Valley Today admin",
		`<div class="error-box">${esc(message)}</div><p><a href="/#creators">&larr; back to Local creators</a></p>`,
	);
}

export function registerCreatorRoutes(
	app: Hono,
	db: Db,
	opts: CreatorRouteOptions = {},
): void {
	// Runs a change, republishes the site's creator data, and returns to the
	// section. A validation failure is the operator's to fix, so it comes back
	// as a readable page rather than a stack trace.
	const change = (c: Context, fn: () => void) => {
		try {
			fn();
		} catch (err) {
			if (err instanceof CreatorInputError) {
				return c.html(inputError(err.message), 400);
			}
			throw err;
		}
		writeCreatorsFiles(db, opts.creatorsDir);
		return c.redirect("/#creators", 303);
	};

	const idParam = (raw: string): number => {
		const id = Number(raw);
		if (!Number.isInteger(id) || id <= 0) {
			throw new CreatorInputError("Unknown entry.");
		}
		return id;
	};

	app.post("/creators", async (c) => {
		const form = await c.req.parseBody();
		return change(c, () => {
			addCreator(db, {
				handle: str(form.handle),
				displayName: str(form.display_name),
				covers: str(form.covers),
				consentAt: str(form.consent_at),
				consentNote: str(form.consent_note),
			});
		});
	});

	app.post("/creators/:id/remove", async (c) => {
		const form = await c.req.parseBody();
		return change(c, () =>
			removeCreator(db, idParam(c.req.param("id")), str(form.reason)),
		);
	});

	app.post("/creators/posts", async (c) => {
		const form = await c.req.parseBody();
		let parsed = parseTikTokUrl(str(form.url));
		if (parsed.kind === "short") {
			parsed = await resolveShortLink(parsed.url, opts.fetchImpl);
		}
		return change(c, () => {
			if (parsed.kind === "error") throw new CreatorInputError(parsed.reason);
			if (parsed.kind !== "video") {
				throw new CreatorInputError("That TikTok link is not a video.");
			}
			addManualPost(db, {
				ref: parsed.ref,
				description: str(form.description),
				ack: str(form.ack) === "1",
			});
		});
	});

	app.post("/creators/posts/:id/approve", async (c) => {
		const form = await c.req.parseBody();
		return change(c, () =>
			approveQueuedPost(db, idParam(c.req.param("id")), {
				description: str(form.description),
				ack: str(form.ack) === "1",
			}),
		);
	});

	app.post("/creators/posts/:id/reject", (c) =>
		change(c, () => rejectQueuedPost(db, idParam(c.req.param("id")))),
	);

	app.post("/creators/posts/:id/remove", async (c) => {
		const form = await c.req.parseBody();
		return change(c, () =>
			removePost(db, idParam(c.req.param("id")), str(form.reason)),
		);
	});
}
