// TikTok Login Kit + Display API client, for creators who connect their own
// account (EDITORIAL.md "Local creators"). This is the only code that calls
// TikTok's API, and it only ever acts with a token the creator granted.
//
// Endpoints as documented on developers.tiktok.com, checked 2026-11-12:
// Login Kit for Web, OAuth token management, /v2/user/info/, /v2/video/list/.
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";

// user.info.profile is asked for only to get the username: the creators table
// is keyed on the handle, user.info.basic no longer carries it (TikTok's 2024
// scope migration), and share_url's format is undocumented.
export const SCOPES = "user.info.basic,user.info.profile,video.list";

/** TikTok lets a creator untick scopes; the connection needs every one. */
export function hasAllScopes(granted: string): boolean {
	const got = new Set(granted.split(",").map((s) => s.trim()));
	return SCOPES.split(",").every((s) => got.has(s));
}

export interface TikTokConfig {
	clientKey: string;
	clientSecret: string;
	redirectUri: string;
}

export function configFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TikTokConfig {
	const clientKey = env.TIKTOK_CLIENT_KEY;
	const clientSecret = env.TIKTOK_CLIENT_SECRET;
	if (!clientKey || !clientSecret) {
		throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set");
	}
	return {
		clientKey,
		clientSecret,
		redirectUri:
			env.CVT_TIKTOK_REDIRECT_URI ??
			"https://chinovalley.today/connect/tiktok/callback",
	};
}

export type Fetch = typeof fetch;

export class TikTokApiError extends Error {
	/** TikTok's error code: `invalid_grant`, `access_token_invalid`, ... */
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

export function newState(): string {
	return randomBytes(24).toString("base64url");
}

export function sameState(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function authorizeUrl(cfg: TikTokConfig, state: string): string {
	const u = new URL(AUTHORIZE_URL);
	u.searchParams.set("client_key", cfg.clientKey);
	u.searchParams.set("scope", SCOPES);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("redirect_uri", cfg.redirectUri);
	u.searchParams.set("state", state);
	return u.href;
}

export interface Tokens {
	openId: string;
	accessToken: string;
	accessExpiresAt: string;
	refreshToken: string;
	refreshExpiresAt: string;
	scope: string;
}

async function tokenRequest(
	fetchImpl: Fetch,
	cfg: TikTokConfig,
	params: Record<string, string>,
	now: Date,
): Promise<Tokens> {
	const res = await fetchImpl(`${API}/oauth/token/`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_key: cfg.clientKey,
			client_secret: cfg.clientSecret,
			...params,
		}),
		signal: AbortSignal.timeout(15000),
	});
	const body = (await res.json()) as Record<string, unknown>;
	if (!res.ok || typeof body.access_token !== "string") {
		throw new TikTokApiError(
			`TikTok token request failed: ${String(body.error_description ?? res.status)}`,
			String(body.error ?? res.status),
		);
	}
	const at = (seconds: unknown) =>
		new Date(now.getTime() + Number(seconds) * 1000).toISOString();
	return {
		openId: String(body.open_id),
		accessToken: body.access_token,
		accessExpiresAt: at(body.expires_in),
		refreshToken: String(body.refresh_token),
		refreshExpiresAt: at(body.refresh_expires_in),
		scope: String(body.scope ?? ""),
	};
}

export function exchangeCode(
	cfg: TikTokConfig,
	code: string,
	fetchImpl: Fetch = fetch,
	now: Date = new Date(),
): Promise<Tokens> {
	return tokenRequest(
		fetchImpl,
		cfg,
		{
			code,
			grant_type: "authorization_code",
			redirect_uri: cfg.redirectUri,
		},
		now,
	);
}

/** Refreshing rotates the refresh token: the old one stops working at once. */
export function refreshTokens(
	cfg: TikTokConfig,
	refreshToken: string,
	fetchImpl: Fetch = fetch,
	now: Date = new Date(),
): Promise<Tokens> {
	return tokenRequest(
		fetchImpl,
		cfg,
		{ grant_type: "refresh_token", refresh_token: refreshToken },
		now,
	);
}

export async function revokeToken(
	cfg: TikTokConfig,
	accessToken: string,
	fetchImpl: Fetch = fetch,
): Promise<void> {
	await fetchImpl(`${API}/oauth/revoke/`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_key: cfg.clientKey,
			client_secret: cfg.clientSecret,
			token: accessToken,
		}),
		signal: AbortSignal.timeout(15000),
	});
}

async function apiCall<T>(
	fetchImpl: Fetch,
	path: string,
	accessToken: string,
	init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
	const res = await fetchImpl(`${API}${path}`, {
		method: init.method,
		headers: {
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(15000),
	});
	const body = (await res.json()) as {
		data?: T;
		error?: { code?: string; message?: string };
	};
	const code = body.error?.code ?? String(res.status);
	if (!res.ok || code !== "ok" || !body.data) {
		throw new TikTokApiError(
			`TikTok ${path} failed: ${body.error?.message || res.status}`,
			code,
		);
	}
	return body.data;
}

export interface TikTokUser {
	openId: string;
	username: string;
	displayName: string;
}

export async function getUser(
	accessToken: string,
	fetchImpl: Fetch = fetch,
): Promise<TikTokUser> {
	const data = await apiCall<{
		user: { open_id: string; username: string; display_name: string };
	}>(
		fetchImpl,
		"/user/info/?fields=open_id,username,display_name",
		accessToken,
		{
			method: "GET",
		},
	);
	return {
		openId: data.user.open_id,
		username: data.user.username,
		displayName: data.user.display_name,
	};
}

export interface TikTokVideo {
	id: string;
	createTime: number; // epoch seconds
	description: string;
}

/**
 * The creator's public posts, newest first, down to `sinceEpoch`. Their
 * captions are read here only to match hashtags; nothing stores them.
 */
export async function listVideosSince(
	accessToken: string,
	sinceEpoch: number,
	fetchImpl: Fetch = fetch,
	// A safety stop, not a window: reaching it throws, so the caller does not
	// advance its checkpoint past posts it never read.
	maxPages = 50,
): Promise<TikTokVideo[]> {
	const out: TikTokVideo[] = [];
	let cursor: number | undefined;
	for (let page = 0; page < maxPages; page++) {
		const data = await apiCall<{
			videos: Array<{
				id: string;
				create_time: number;
				video_description?: string;
			}>;
			cursor: number;
			has_more: boolean;
		}>(
			fetchImpl,
			"/video/list/?fields=id,create_time,video_description",
			accessToken,
			{
				method: "POST",
				body:
					cursor === undefined ? { max_count: 20 } : { max_count: 20, cursor },
			},
		);
		for (const v of data.videos ?? []) {
			if (v.create_time < sinceEpoch) return out;
			out.push({
				id: String(v.id),
				createTime: v.create_time,
				description: v.video_description ?? "",
			});
		}
		if (!data.has_more) return out;
		cursor = data.cursor;
	}
	throw new Error(
		`video list still had more after ${maxPages} pages; not marking it read`,
	);
}

// --- Tokens at rest ---------------------------------------------------------
// AES-256-GCM with a 32-byte key from CVT_TIKTOK_TOKEN_KEY (base64), so the
// database and its offsite backups never hold a usable token.

export function tokenKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
	const key = Buffer.from(env.CVT_TIKTOK_TOKEN_KEY ?? "", "base64");
	if (key.length !== 32) {
		throw new Error(
			"CVT_TIKTOK_TOKEN_KEY must be 32 random bytes, base64 (openssl rand -base64 32)",
		);
	}
	return key;
}

export function seal(key: Buffer, plaintext: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
	return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function unseal(key: Buffer, sealed: string): string {
	const [iv, tag, ct] = sealed
		.split(".")
		.map((p) => Buffer.from(p, "base64url"));
	const d = createDecipheriv("aes-256-gcm", key, iv);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
