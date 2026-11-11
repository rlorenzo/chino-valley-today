// Local creators and their featured posts: the state behind the dashboard's
// "Local creators" section, /creators/, and the brief's creator videos.
// EDITORIAL.md "Local creators" is the policy this enforces.
import type { Db } from "../db/index.ts";
import { normalizeHandle, type TikTokVideoRef } from "./tiktok.ts";

export const DESCRIPTION_MAX = 200;
export const COVERS_MAX = 120;
export const DISPLAY_NAME_MAX = 60;
// Consent notes and removal reasons: dashboard-only, capped so a stray paste
// cannot store a page of text.
export const NOTE_MAX = 300;

// Recorded on every approval, the way TIER_C_ACK is on post approvals. The
// dashboard shows it beside a required checkbox and the server refuses an
// approval without it: a raw form POST can skip the HTML `required`.
export const CREATOR_POST_ACK =
	"I watched this video. No child is its focus or identifiable in it, no private person is featured in a way they would object to, and the description is in my own words.";

export interface CreatorRow {
	id: number;
	platform: "tiktok";
	handle: string;
	display_name: string;
	covers: string | null;
	consent_at: string | null;
	consent_note: string | null;
	added_at: string;
	removed_at: string | null;
}

export interface CreatorPostRow {
	id: number;
	creator_id: number;
	platform: "tiktok";
	video_id: string;
	url: string;
	description: string;
	origin: "manual" | "api";
	status: "queued" | "published" | "rejected" | "removed";
	review_ack: string | null;
	added_at: string;
	published_at: string | null;
	removed_at: string | null;
	removed_reason: string | null;
}

export interface CreatorPostWithCreator extends CreatorPostRow {
	handle: string;
	display_name: string;
}

export class CreatorInputError extends Error {}

/** Collapses whitespace and strips control characters from one line of text. */
export function cleanLine(raw: string): string {
	const printable = Array.from(raw, (ch) => {
		const code = ch.charCodeAt(0);
		return code < 0x20 || code === 0x7f ? " " : ch;
	}).join("");
	return printable.replace(/\s+/g, " ").trim();
}

export function addCreator(
	db: Db,
	input: {
		handle: string;
		displayName: string;
		covers?: string;
		consentAt?: string | null;
		consentNote?: string;
	},
	now: Date = new Date(),
): CreatorRow {
	const handle = normalizeHandle(input.handle);
	if (!handle) {
		throw new CreatorInputError(
			"That is not a TikTok username (2-24 letters, numbers, periods or underscores).",
		);
	}
	const displayName = cleanLine(input.displayName);
	if (!displayName) throw new CreatorInputError("A display name is required.");
	if (displayName.length > DISPLAY_NAME_MAX) {
		throw new CreatorInputError(
			`The display name is limited to ${DISPLAY_NAME_MAX} characters.`,
		);
	}
	const consentNote =
		cleanLine(input.consentNote ?? "").slice(0, NOTE_MAX) || null;
	const covers = cleanLine(input.covers ?? "");
	if (covers.length > COVERS_MAX) {
		throw new CreatorInputError(
			`"What they cover" is limited to ${COVERS_MAX} characters.`,
		);
	}
	const consentAt = input.consentAt?.trim() || null;
	if (consentAt && !/^\d{4}-\d{2}-\d{2}$/.test(consentAt)) {
		throw new CreatorInputError("The consent date must be YYYY-MM-DD.");
	}
	const existing = getCreatorByHandle(db, handle);
	const addedAt = now.toISOString();
	if (existing) {
		// Updating a listed creator (e.g. recording consent for one added from a
		// post link), or re-adding one who was taken off: same row, so their
		// posts, history and any earlier removal reasons stay attached to one
		// identity. A listed creator keeps their original added_at.
		db.raw
			.prepare(
				`UPDATE creators SET display_name = ?, covers = ?, consent_at = ?,
				 consent_note = ?, added_at = CASE WHEN removed_at IS NULL THEN added_at ELSE ? END,
				 removed_at = NULL WHERE id = ?`,
			)
			.run(
				displayName,
				covers || null,
				consentAt,
				consentNote,
				addedAt,
				existing.id,
			);
	} else {
		db.raw
			.prepare(
				`INSERT INTO creators (platform, handle, display_name, covers, consent_at, consent_note, added_at)
				 VALUES ('tiktok', ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				handle,
				displayName,
				covers || null,
				consentAt,
				consentNote,
				addedAt,
			);
	}
	return getCreatorByHandle(db, handle) as CreatorRow;
}

export function getCreatorByHandle(
	db: Db,
	handle: string,
): CreatorRow | undefined {
	return db.raw
		.prepare(`SELECT * FROM creators WHERE platform = 'tiktok' AND handle = ?`)
		.get(handle) as unknown as CreatorRow | undefined;
}

export function listCreators(db: Db): CreatorRow[] {
	return db.raw
		.prepare(
			`SELECT * FROM creators WHERE removed_at IS NULL ORDER BY display_name COLLATE NOCASE`,
		)
		.all() as unknown as CreatorRow[];
}

/**
 * Takes a creator off the list, and every post of theirs off the site with
 * them. A creator asking to be removed is asking for all of it, not for the
 * profile alone.
 */
export function removeCreator(
	db: Db,
	creatorId: number,
	reason: string,
	now: Date = new Date(),
): void {
	const at = now.toISOString();
	// One transaction: a creator marked removed whose posts stayed published
	// would vanish from the dashboard while the export kept publishing them.
	db.raw.exec("BEGIN IMMEDIATE");
	try {
		const res = db.raw
			.prepare(
				`UPDATE creators SET removed_at = ? WHERE id = ? AND removed_at IS NULL`,
			)
			.run(at, creatorId);
		if (Number(res.changes) === 0) {
			throw new CreatorInputError("That creator is not on the list.");
		}
		db.raw
			.prepare(
				`UPDATE creator_posts SET status = 'removed', removed_at = ?, removed_reason = ?
				 WHERE creator_id = ? AND status IN ('queued', 'published')`,
			)
			.run(at, reasonLine(reason, "creator removed"), creatorId);
		db.raw.exec("COMMIT");
	} catch (err) {
		db.raw.exec("ROLLBACK");
		throw err;
	}
}

function reasonLine(raw: string, fallback: string): string {
	return cleanLine(raw).slice(0, NOTE_MAX) || fallback;
}

function validateDescription(raw: string): string {
	const description = cleanLine(raw);
	if (!description) {
		throw new CreatorInputError(
			"A one-line description is required, in your own words.",
		);
	}
	if (description.length > DESCRIPTION_MAX) {
		throw new CreatorInputError(
			`The description is limited to ${DESCRIPTION_MAX} characters.`,
		);
	}
	return description;
}

/**
 * Adds a post the operator picked. The operator watched it and wrote the line,
 * so adding it is the review: it is stored published, with the acknowledgment.
 */
export function addManualPost(
	db: Db,
	input: {
		ref: TikTokVideoRef;
		description: string;
		ack: boolean;
		displayName?: string;
	},
	now: Date = new Date(),
): CreatorPostRow {
	if (!input.ack) {
		throw new CreatorInputError(
			"Tick the review box: it confirms you watched the video and checked it for children and private people.",
		);
	}
	const description = validateDescription(input.description);
	let creator = getCreatorByHandle(db, input.ref.handle);
	if (creator?.removed_at) {
		// Taken off the list, possibly at their own request: re-adding them is a
		// deliberate act in the Creators form, never a side effect of a link.
		throw new CreatorInputError(
			`@${input.ref.handle} was removed from the creators list. Add them again there first if they are back.`,
		);
	}
	const existing = getPost(db, input.ref.videoId);
	if (existing?.status === "published") {
		throw new CreatorInputError("That video is already featured.");
	}
	if (existing?.status === "queued") {
		throw new CreatorInputError(
			"That video is already waiting for review below.",
		);
	}
	// A new creator is added from the link without consent: their post can be
	// featured (linking a public post needs no permission), but they get no
	// profile on /creators/ until consent is recorded.
	creator ??= addCreator(
		db,
		{
			handle: input.ref.handle,
			displayName: input.displayName?.trim() || input.ref.handle,
		},
		now,
	);
	const at = now.toISOString();
	if (existing) {
		// Removed or rejected earlier and deliberately added again: the same row
		// comes back, so the video keeps one identity and one history.
		db.raw
			.prepare(
				`UPDATE creator_posts SET creator_id = ?, url = ?, description = ?, origin = 'manual',
				 status = 'published', review_ack = ?, published_at = ?, removed_at = NULL, removed_reason = NULL
				 WHERE id = ?`,
			)
			.run(
				creator.id,
				input.ref.url,
				description,
				CREATOR_POST_ACK,
				at,
				existing.id,
			);
		return getPost(db, input.ref.videoId) as CreatorPostRow;
	}
	db.raw
		.prepare(
			`INSERT INTO creator_posts
			 (creator_id, platform, video_id, url, description, origin, status, review_ack, added_at, published_at)
			 VALUES (?, 'tiktok', ?, ?, ?, 'manual', 'published', ?, ?, ?)`,
		)
		.run(
			creator.id,
			input.ref.videoId,
			input.ref.url,
			description,
			CREATOR_POST_ACK,
			at,
			at,
		);
	return getPost(db, input.ref.videoId) as CreatorPostRow;
}

/**
 * Approves a queued post (the future API path). Same acknowledgment as a
 * manual add, and the operator may rewrite the line on the way through.
 */
export function approveQueuedPost(
	db: Db,
	postId: number,
	input: { description: string; ack: boolean },
	now: Date = new Date(),
): void {
	if (!input.ack) {
		throw new CreatorInputError(
			"Tick the review box: it confirms you watched the video and checked it for children and private people.",
		);
	}
	const description = validateDescription(input.description);
	const res = db.raw
		.prepare(
			`UPDATE creator_posts SET status = 'published', description = ?, review_ack = ?, published_at = ?
			 WHERE id = ? AND status = 'queued'`,
		)
		.run(description, CREATOR_POST_ACK, now.toISOString(), postId);
	if (Number(res.changes) === 0) {
		throw new CreatorInputError("That post is not waiting for review.");
	}
}

export function rejectQueuedPost(db: Db, postId: number): void {
	const res = db.raw
		.prepare(
			`UPDATE creator_posts SET status = 'rejected' WHERE id = ? AND status = 'queued'`,
		)
		.run(postId);
	if (Number(res.changes) === 0) {
		throw new CreatorInputError("That post is not waiting for review.");
	}
}

/** Takes a published post down. Kept as a row so it can never be re-added by accident. */
export function removePost(
	db: Db,
	postId: number,
	reason: string,
	now: Date = new Date(),
): void {
	const res = db.raw
		.prepare(
			`UPDATE creator_posts SET status = 'removed', removed_at = ?, removed_reason = ?
			 WHERE id = ? AND status = 'published'`,
		)
		.run(now.toISOString(), reasonLine(reason, "removed"), postId);
	if (Number(res.changes) === 0) {
		throw new CreatorInputError("That post is not published.");
	}
}

function getPost(db: Db, videoId: string): CreatorPostRow | undefined {
	return db.raw
		.prepare(
			`SELECT * FROM creator_posts WHERE platform = 'tiktok' AND video_id = ?`,
		)
		.get(videoId) as unknown as CreatorPostRow | undefined;
}

export function listCreatorPosts(
	db: Db,
	status: CreatorPostRow["status"],
): CreatorPostWithCreator[] {
	return db.raw
		.prepare(
			`SELECT p.*, c.handle AS handle, c.display_name AS display_name
			 FROM creator_posts p JOIN creators c ON c.id = p.creator_id
			 WHERE p.status = ?
			 ORDER BY COALESCE(p.published_at, p.added_at) DESC, p.id DESC`,
		)
		.all(status) as unknown as CreatorPostWithCreator[];
}
