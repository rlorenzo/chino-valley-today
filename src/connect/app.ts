// The public "connect your TikTok" pages: the one dynamic corner of
// chinovalley.today. Caddy proxies /connect/tiktok* here and nothing else, and
// this app can do exactly one thing: record a creator's own authorization.
// It cannot approve, publish or remove anything; that stays in the dashboard
// behind the SSH tunnel.
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { completeConnection } from "../creators/connections.ts";
import {
	authorizeUrl,
	exchangeCode,
	type Fetch,
	hasAllScopes,
	newState,
	revokeToken,
	sameState,
	type TikTokConfig,
} from "../creators/tiktok-api.ts";
import type { Db } from "../db/index.ts";
import { esc } from "../html.ts";

const STATE_COOKIE = "cvt_tiktok_state";
const COOKIE_PATH = "/connect/tiktok";
const MAIL = "corrections@chinovalley.today";

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Chino Valley Today</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5d5c57;--accent:#7a3cc2}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a3a29b;--accent:#b892ee}}
body{background:var(--bg);color:var(--fg);font:17px/1.55 system-ui,sans-serif;margin:0;padding:32px 16px}
main{max-width:620px;margin:0 auto}
a{color:var(--accent)}
.muted{color:var(--muted)}
.button{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600}
</style></head><body><main>
<p><a href="/">Chino Valley Today</a></p>
<h1>${esc(title)}</h1>
${body}
</main></body></html>`;
}

const LANDING = page(
	"Connect your TikTok",
	`<p>If you post about Chino, Chino Hills or the Chino Valley, you can connect your TikTok account so we can feature your videos on <a href="/creators/">our local creators page</a> and in the morning brief.</p>
<h2>What connecting means</h2>
<ul>
<li>You agree to be listed on our local creators page.</li>
<li>Once a day we check your public videos for <b>#chino</b>, <b>#chinohills</b> or <b>#chinovalley</b>.</li>
<li>A person on our team watches each one before anything appears. Most will not be featured, and that is normal.</li>
<li>We write our own one-line description. We do not copy your caption, video or thumbnail. Readers watch your video in TikTok's own player, with a link back to you.</li>
<li>We store your TikTok username, display name and access tokens (encrypted). We do not store your captions, followers or anything private.</li>
</ul>
<h2>Stopping</h2>
<p>Disconnect any time in the TikTok app (Settings and privacy, Security and permissions, Apps and services permissions). To also take down featured videos or your profile, email <a href="mailto:${MAIL}">${MAIL}</a>.</p>
<p><a class="button" href="/connect/tiktok/start">Connect with TikTok</a></p>
<p class="muted">See our <a href="/privacy/">privacy policy</a> and <a href="/terms/">terms</a>.</p>`,
);

export interface ConnectOptions {
	cfg: TikTokConfig;
	key: Buffer;
	fetchImpl?: Fetch;
}

export function createConnectApp(db: Db, opts: ConnectOptions): Hono {
	const app = new Hono();
	const fetchImpl = opts.fetchImpl ?? fetch;

	app.get("/connect/tiktok", (c) => c.html(LANDING));

	app.get("/connect/tiktok/start", (c) => {
		const state = newState();
		setCookie(c, STATE_COOKIE, state, {
			path: COOKIE_PATH,
			httpOnly: true,
			secure: true,
			// Lax, not Strict: the callback is a top-level navigation from
			// tiktok.com, and Strict would withhold the cookie on it.
			sameSite: "Lax",
			maxAge: 600,
		});
		return c.redirect(authorizeUrl(opts.cfg, state), 302);
	});

	app.get("/connect/tiktok/callback", async (c) => {
		const expected = getCookie(c, STATE_COOKIE) ?? "";
		deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH, secure: true });
		const { code, state, error } = c.req.query();
		if (error) {
			return c.html(
				page(
					"Not connected",
					`<p>TikTok did not connect your account, so nothing was saved. <a href="/connect/tiktok">Try again</a> if you meant to.</p>`,
				),
			);
		}
		if (!code || !state || !sameState(state, expected)) {
			return c.html(
				page(
					"That link expired",
					`<p>Please <a href="/connect/tiktok">start again</a> from our page. The connection has to begin and end in the same browser, within ten minutes.</p>`,
				),
				400,
			);
		}
		try {
			const tokens = await exchangeCode(opts.cfg, code, fetchImpl);
			if (!hasAllScopes(tokens.scope)) {
				await revokeToken(opts.cfg, tokens.accessToken, fetchImpl).catch(
					() => {},
				);
				return c.html(
					page(
						"Not connected",
						`<p>We need all three permissions TikTok asked about: your username and display name, and your list of public videos. Without the video list we cannot find your posts, so nothing was saved. <a href="/connect/tiktok">Try again</a> and leave them all ticked.</p>`,
					),
					400,
				);
			}
			const who = await completeConnection(db, opts.key, tokens, fetchImpl);
			return c.html(
				page(
					"You're connected",
					`<p>Thanks, ${esc(who.displayName)}. We will look for your videos tagged #chino, #chinohills or #chinovalley, and a person will review each one before it appears. Your profile shows on <a href="/creators/">the creators page</a> after the next site update, usually the next morning.</p>`,
				),
			);
		} catch (err) {
			console.error("tiktok connect failed:", err);
			return c.html(
				page(
					"Something went wrong",
					`<p>We could not finish connecting your account, and nothing was saved. Please <a href="/connect/tiktok">try again</a>, or email <a href="mailto:${MAIL}">${MAIL}</a>.</p>`,
				),
				502,
			);
		}
	});

	return app;
}
