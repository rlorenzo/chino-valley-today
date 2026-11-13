// Creator-connected TikTok accounts: saving a connection from the Login Kit
// callback, and the daily poll that queues their Chino-tagged posts for
// review. Run the poll with: node src/creators/connections.ts
//
// EDITORIAL.md "Local creators": connecting is the creator's consent to be
// featured; every post still waits for the dashboard approval and its
// acknowledgment; the creator's caption is read to match hashtags and is never
// stored or shown.
import { pathToFileURL } from "node:url";
import { type Db, openDb } from "../db/index.ts";
import { addCreator, getCreatorByHandle } from "./store.ts";
import { canonicalVideoUrl, normalizeHandle } from "./tiktok.ts";
import {
	configFromEnv,
	type Fetch,
	getUser,
	listVideosSince,
	refreshTokens,
	revokeToken,
	seal,
	TikTokApiError,
	type TikTokConfig,
	type TikTokUser,
	type Tokens,
	tokenKeyFromEnv,
	unseal,
} from "./tiktok-api.ts";

export const CONNECT_CONSENT_NOTE = "Connected their TikTok account";
export const DEFAULT_HASHTAGS = ["chino", "chinohills", "chinovalley"];
// How far back the first poll after connecting looks.
const FIRST_POLL_DAYS = 30;
// Re-read a day before the last poll: a video's create_time can predate the
// moment it became public, and the UNIQUE video id makes overlap harmless.
const POLL_OVERLAP_S = 24 * 3600;

interface ConnectionRow {
	open_id: string;
	creator_id: number;
	access_token: string;
	access_expires_at: string;
	refresh_token: string;
	refresh_expires_at: string;
	scope: string;
	connected_at: string;
	last_polled_at: string | null;
	handle: string;
	removed_at: string | null;
}

export function hashtagsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const raw = env.CVT_TIKTOK_HASHTAGS;
	if (!raw) return DEFAULT_HASHTAGS;
	return raw
		.split(",")
		.map((t) => t.trim().replace(/^#/, "").toLowerCase())
		.filter(Boolean);
}

/** Exact hashtag match, case-insensitive: #chino matches, #chinofood does not. */
export function hasHashtag(caption: string, wanted: string[]): boolean {
	const tags = new Set(
		Array.from(caption.matchAll(/#([\p{L}\p{N}_]+)/gu), (m) =>
			m[1].toLowerCase(),
		),
	);
	return wanted.some((t) => tags.has(t));
}

/**
 * Stores refreshed tokens only if the row still holds the refresh token they
 * replace (`generation`), so a poll can never overwrite or delete a newer
 * connection the creator made while it was waiting on TikTok. Returns the new
 * generation.
 */
function storeTokens(
	db: Db,
	key: Buffer,
	t: Tokens,
	generation: string,
): string {
	const sealedRefresh = seal(key, t.refreshToken);
	db.raw
		.prepare(
			`UPDATE tiktok_connections SET access_token = ?, access_expires_at = ?,
			 refresh_token = ?, refresh_expires_at = ?, scope = ?
			 WHERE open_id = ? AND refresh_token = ?`,
		)
		.run(
			seal(key, t.accessToken),
			t.accessExpiresAt,
			sealedRefresh,
			t.refreshExpiresAt,
			t.scope,
			t.openId,
			generation,
		);
	return sealedRefresh;
}

/**
 * Records a creator who just authorized the app. They are added to (or put
 * back on) the creators list with consent dated today. A creator taken off the
 * list who connects again is asking to come back, and connecting is their own
 * act, unlike a pasted link.
 */
export function saveConnection(
	db: Db,
	key: Buffer,
	tokens: Tokens,
	user: TikTokUser,
	now: Date = new Date(),
): { handle: string; displayName: string } {
	const handle = normalizeHandle(user.username);
	if (!handle)
		throw new Error(`TikTok returned an unusable username: ${user.username}`);
	db.raw.exec("BEGIN IMMEDIATE");
	try {
		const result = saveConnectionTx(db, key, tokens, user, handle, now);
		db.raw.exec("COMMIT");
		return result;
	} catch (err) {
		db.raw.exec("ROLLBACK");
		throw err;
	}
}

function saveConnectionTx(
	db: Db,
	key: Buffer,
	tokens: Tokens,
	user: TikTokUser,
	handle: string,
	now: Date,
): { handle: string; displayName: string } {
	// The account is the identity, not the username: a creator who renamed
	// themselves and reconnects keeps their row, consent and posts.
	const linked = db.raw
		.prepare(
			`SELECT c.id, c.handle FROM tiktok_connections t
			 JOIN creators c ON c.id = t.creator_id WHERE t.open_id = ?`,
		)
		.get(tokens.openId) as { id: number; handle: string } | undefined;
	if (linked && linked.handle !== handle) {
		if (getCreatorByHandle(db, handle)) {
			throw new Error(
				`@${handle} is already a different creator on the list; merge them by hand`,
			);
		}
		db.raw
			.prepare(`UPDATE creators SET handle = ? WHERE id = ?`)
			.run(handle, linked.id);
		db.raw
			.prepare(
				`UPDATE creator_posts SET url = 'https://www.tiktok.com/@' || ? || '/video/' || video_id
				 WHERE creator_id = ?`,
			)
			.run(handle, linked.id);
	}
	const existing = getCreatorByHandle(db, handle);
	const creator = addCreator(
		db,
		{
			handle,
			// The operator's wording wins over the profile's once there is one.
			displayName: existing?.display_name ?? (user.displayName || handle),
			covers: existing?.covers ?? "",
			consentAt: now.toISOString().slice(0, 10),
			consentNote: CONNECT_CONSENT_NOTE,
		},
		now,
	);
	db.raw
		.prepare(
			`INSERT INTO tiktok_connections
			 (open_id, creator_id, access_token, access_expires_at, refresh_token, refresh_expires_at, scope, connected_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(open_id) DO UPDATE SET creator_id = excluded.creator_id,
			   access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
			   refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
			   scope = excluded.scope`,
		)
		.run(
			tokens.openId,
			creator.id,
			seal(key, tokens.accessToken),
			tokens.accessExpiresAt,
			seal(key, tokens.refreshToken),
			tokens.refreshExpiresAt,
			tokens.scope,
			now.toISOString(),
		);
	return { handle, displayName: creator.display_name };
}

function dropConnection(db: Db, openId: string, generation: string): number {
	return Number(
		db.raw
			.prepare(
				`DELETE FROM tiktok_connections WHERE open_id = ? AND refresh_token = ?`,
			)
			.run(openId, generation).changes,
	);
}

export interface PollResult {
	queued: number;
	dropped: number;
	failed: number;
}

export async function pollConnections(
	db: Db,
	cfg: TikTokConfig,
	key: Buffer,
	opts: { hashtags?: string[]; fetchImpl?: Fetch; now?: Date } = {},
): Promise<PollResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? new Date();
	const hashtags = opts.hashtags ?? DEFAULT_HASHTAGS;
	const result: PollResult = { queued: 0, dropped: 0, failed: 0 };
	const rows = db.raw
		.prepare(
			`SELECT t.*, c.handle, c.removed_at FROM tiktok_connections t
			 JOIN creators c ON c.id = t.creator_id`,
		)
		.all() as unknown as ConnectionRow[];
	const insert = db.raw.prepare(
		// Re-checks removal at insert time: a creator removed in the dashboard
		// while this poll waited on TikTok gets nothing queued.
		`INSERT OR IGNORE INTO creator_posts
		 (creator_id, platform, video_id, url, description, origin, status, added_at)
		 SELECT id, 'tiktok', ?, ?, '', 'api', 'queued', ? FROM creators
		 WHERE id = ? AND removed_at IS NULL`,
	);

	for (const row of rows) {
		let generation = row.refresh_token;
		const drop = () => {
			result.dropped += dropConnection(db, row.open_id, generation);
		};
		const refresh = async () => {
			const t = await refreshTokens(
				cfg,
				unseal(key, generation),
				fetchImpl,
				now,
			);
			generation = storeTokens(
				db,
				key,
				{ ...t, openId: row.open_id },
				generation,
			);
			return t.accessToken;
		};
		try {
			let accessToken = unseal(key, row.access_token);
			if (row.removed_at) {
				// Removed in the dashboard: stop reading their account entirely.
				await revokeToken(cfg, accessToken, fetchImpl).catch(() => {});
				drop();
				continue;
			}
			if (Date.parse(row.refresh_expires_at) <= now.getTime()) {
				drop();
				continue;
			}
			if (Date.parse(row.access_expires_at) - now.getTime() < 5 * 60 * 1000) {
				accessToken = await refresh();
			}
			const lastPolled = row.last_polled_at
				? Date.parse(row.last_polled_at) / 1000 - POLL_OVERLAP_S
				: Date.parse(row.connected_at) / 1000 - FIRST_POLL_DAYS * 86400;
			const since = Math.floor(lastPolled);
			let videos: Awaited<ReturnType<typeof listVideosSince>>;
			try {
				videos = await listVideosSince(accessToken, since, fetchImpl);
			} catch (err) {
				// TikTok's documented fix for an invalid access token is a refresh
				// and one retry; only a failed refresh means the grant is gone.
				if (
					!(
						err instanceof TikTokApiError && err.code === "access_token_invalid"
					)
				)
					throw err;
				videos = await listVideosSince(await refresh(), since, fetchImpl);
			}
			const at = now.toISOString();
			for (const v of videos) {
				if (!hasHashtag(v.description, hashtags)) continue;
				const res = insert.run(
					v.id,
					canonicalVideoUrl(row.handle, v.id),
					at,
					row.creator_id,
				);
				result.queued += Number(res.changes);
			}
			db.raw
				.prepare(
					`UPDATE tiktok_connections SET last_polled_at = ? WHERE open_id = ?`,
				)
				.run(at, row.open_id);
		} catch (err) {
			if (
				err instanceof TikTokApiError &&
				[
					"invalid_grant",
					"access_token_invalid",
					"scope_not_authorized",
				].includes(err.code)
			) {
				// The creator disconnected the app in TikTok, or the grant lapsed
				// (access_token_invalid lands here only after a refresh and retry).
				drop();
				continue;
			}
			console.error(`tiktok poll @${row.handle}:`, err);
			result.failed++;
		}
	}
	return result;
}

/** Callback helper: everything the connect service does after TikTok redirects back. */
export async function completeConnection(
	db: Db,
	key: Buffer,
	tokens: Tokens,
	fetchImpl: Fetch = fetch,
): Promise<{ handle: string; displayName: string }> {
	const user = await getUser(tokens.accessToken, fetchImpl);
	return saveConnection(db, key, tokens, user);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	if (!process.env.TIKTOK_CLIENT_KEY) {
		// Not set up yet (app review pending): nothing to poll, and not a failure.
		console.log("tiktok poll: TIKTOK_CLIENT_KEY not set, skipping");
		process.exit(0);
	}
	const db = openDb();
	const r = await pollConnections(db, configFromEnv(), tokenKeyFromEnv(), {
		hashtags: hashtagsFromEnv(),
	});
	console.log(
		`tiktok poll: ${r.queued} queued for review, ${r.dropped} connections ended, ${r.failed} failed`,
	);
	if (r.failed > 0) process.exitCode = 1;
}
