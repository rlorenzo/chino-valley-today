// TikTok links, as the operator pastes them into the admin dashboard.
//
// Nothing here reads a TikTok page. A full video URL carries everything the
// site needs (the creator's handle and the video id) in its path, and a share
// short link (vm.tiktok.com/..., tiktok.com/t/...) is resolved by reading the
// redirect's Location header only, the way a browser would on one click. That
// is the whole of our contact with TikTok on the add path: TikTok's terms bar
// scraping, and EDITORIAL.md "Local creators" holds us to that.
//
// TikTok's oEmbed endpoint is deliberately not used to validate a link. Probed
// 2026-11-07, it answers 200 with a player iframe for ANY numeric id, including
// ids that do not exist, and no longer returns the author — so it can confirm
// neither that a video exists nor whose it is.

export const TIKTOK_PLAYER_ORIGIN = "https://www.tiktok.com";

const FULL_HOSTS = new Set(["www.tiktok.com", "tiktok.com", "m.tiktok.com"]);
const SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);

// TikTok usernames: letters, digits, underscores and periods, 2-24 characters.
const HANDLE_RE = /^[a-z0-9._]{2,24}$/;
// Video ids are 64-bit snowflakes, 19 digits for anything posted since ~2019.
const VIDEO_ID_RE = /^\d{15,20}$/;

export interface TikTokVideoRef {
	handle: string; // lowercase, no '@'
	videoId: string;
	url: string; // canonical: https://www.tiktok.com/@handle/video/<id>
}

export type ParsedTikTokUrl =
	| { kind: "video"; ref: TikTokVideoRef }
	| { kind: "short"; url: string }
	| { kind: "error"; reason: string };

export function normalizeHandle(raw: string): string | null {
	const h = raw.trim().replace(/^@/, "").toLowerCase();
	return HANDLE_RE.test(h) ? h : null;
}

export function canonicalVideoUrl(handle: string, videoId: string): string {
	return `https://www.tiktok.com/@${handle}/video/${videoId}`;
}

export function profileUrl(handle: string): string {
	return `https://www.tiktok.com/@${handle}`;
}

/** The embed player URL the site's click-to-play card swaps in. */
export function playerUrl(videoId: string): string {
	return `${TIKTOK_PLAYER_ORIGIN}/player/v1/${videoId}`;
}

export function parseTikTokUrl(input: string): ParsedTikTokUrl {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { kind: "error", reason: "That is not a link." };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { kind: "error", reason: "That is not a web link." };
	}
	const host = url.hostname.toLowerCase();

	if (SHORT_HOSTS.has(host)) {
		return {
			kind: "short",
			url: `https://${host}${url.pathname}`,
		};
	}
	if (!FULL_HOSTS.has(host)) {
		return { kind: "error", reason: "That is not a TikTok link." };
	}

	const parts = url.pathname.split("/").filter(Boolean);
	// tiktok.com/t/<code>/ is the in-app share form of a short link.
	if (parts[0] === "t" && parts.length === 2) {
		return { kind: "short", url: `https://www.tiktok.com/t/${parts[1]}/` };
	}
	if (parts.length >= 3 && parts[0].startsWith("@")) {
		const handle = normalizeHandle(parts[0]);
		const kind = parts[1];
		const videoId = parts[2];
		if (kind === "photo") {
			return {
				kind: "error",
				reason:
					"That is a photo post. Only videos can be featured, because the embed player plays videos.",
			};
		}
		if (kind === "video" && handle && VIDEO_ID_RE.test(videoId)) {
			return {
				kind: "video",
				ref: { handle, videoId, url: canonicalVideoUrl(handle, videoId) },
			};
		}
	}
	if (parts.length === 1 && parts[0].startsWith("@")) {
		return {
			kind: "error",
			reason:
				"That is a profile link. Open the video itself and copy its link.",
		};
	}
	return { kind: "error", reason: "That TikTok link is not a video." };
}

export type FetchLike = (
	input: string,
	init: { method: string; redirect: "manual"; headers: Record<string, string> },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

const MAX_HOPS = 4;

/**
 * Follows a share short link to the video it names, reading only each
 * redirect's Location header. Every hop must stay on a TikTok host, and the
 * chain must end at a /@handle/video/<id> URL: a short link for a deleted
 * video redirects to the TikTok home page, which this reports as an error
 * rather than guessing.
 */
export async function resolveShortLink(
	shortUrl: string,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ParsedTikTokUrl> {
	let current = shortUrl;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		let res: Awaited<ReturnType<FetchLike>>;
		try {
			res = await fetchImpl(current, {
				method: "HEAD",
				redirect: "manual",
				headers: { "user-agent": "ChinoValleyToday-admin/1.0" },
			});
		} catch {
			return {
				kind: "error",
				reason: "Could not reach TikTok to open that short link.",
			};
		}
		const location = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !location) {
			return {
				kind: "error",
				reason:
					"That short link did not lead to a video. Open it in the TikTok app and copy the full link instead.",
			};
		}
		const next = new URL(location, current).href;
		const parsed = parseTikTokUrl(next);
		if (parsed.kind === "video") return parsed;
		if (parsed.kind === "short") {
			current = parsed.url;
			continue;
		}
		// Same reason either way: the chain left TikTok, or ended somewhere that
		// is not a video (the home page, for a deleted one).
		return {
			kind: "error",
			reason:
				"That short link did not lead to a video. It may have been deleted.",
		};
	}
	return {
		kind: "error",
		reason: "That short link redirected too many times.",
	};
}
