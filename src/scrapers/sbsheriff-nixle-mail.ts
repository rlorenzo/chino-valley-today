// Task 0.9 (amended 2026-08-12) — SB Sheriff Chino Hills station via Nixle,
// ingested by EMAIL SUBSCRIPTION, never by page scraping.
//
// Why email: the station's press releases are distributed exclusively through
// Everbridge's Nixle service (see reports/notes/sbsheriff-news.md for the full
// evidence trail — the WordPress site's post system has been empty since ~2021
// and every station card links to a Nixle channel). Nixle's resident ToS
// expressly prohibits automated scraping of the Service's web pages (search
// engines excepted), so this ingester consumes the service's INTENDED delivery
// mechanism: alert emails to a subscribed mailbox we control
// (the address is deployment configuration, kept in .env and out of this
// public repository; subscribed 2026-08-13). Each message
// carries a local.nixle.com/alert/<id>/ permalink; that public URL — not the
// mailbox — is what readers get as source_url.
//
// Scope note (2026-08-17): a Nixle subscription delivers every agency channel
// covering the subscribed area, so this mailbox receives county-wide SBSD
// releases (Loma Linda, Mentone, Hesperia…) alongside anything the Chino Hills
// station posts. All of it is ingested with the true channel recorded and
// Chino relevance flagged in meta — the archive stays complete and the
// editorial call happens downstream (same policy as sbcfire-news).
//
// Editorial: Tier C source. Releases routinely name private individuals; the
// pipeline must never auto-publish items from this source (PLAN Phase 1 tier
// rules; EDITORIAL.md).
//
// Mailbox access is read-only by design: messages are fetched with BODY.PEEK
// (ImapFlow's default for `source`) and never flagged, moved, or deleted —
// the mailbox itself remains the humans' archive.
//
// Config (.env):
//   NIXLE_IMAP_USER      mailbox login (a Gmail address)
//   NIXLE_IMAP_PASSWORD  app password (Gmail: Account -> Security -> 2-Step
//                        Verification -> App passwords)
//   NIXLE_IMAP_HOST      default imap.gmail.com
//   NIXLE_IMAP_PORT      default 993
//   NIXLE_MAIL_ALIAS     optional plus-alias the subscription was made with.
//                        When set, messages match on To/Cc/Delivered-To
//                        containing it OR a sender containing "nixle"; when
//                        unset, on the sender alone.
//   NIXLE_MAIL_SINCE_DAYS  IMAP search window, default 90
// Without user+password the scraper notes the gap and returns cleanly, so
// `npm run poc` stays green on machines without mailbox credentials.

import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { ROOT, saveRaw } from "../store.ts";
import type { ScraperContext, ScraperDef } from "./types.ts";

// Same .env loading as src/llm/config.ts — the scraper runners don't load it,
// and mailbox credentials live there alongside the LLM key.
try {
	process.loadEnvFile(join(ROOT, ".env"));
} catch {
	// no .env — the credential guard in run() reports the gap
}

// The Chino Hills station channel — the reason this source exists, but NOT the
// only channel that reaches the mailbox. A Nixle subscription covers every
// agency serving the subscribed area, so county-wide channels (SBSD -
// Headquarters, SBSD - Central) deliver here too. The real channel is derived
// per message from the sender; this constant is only the source's baseUrl.
const CHANNEL_URL =
	"https://local.nixle.com/sbsd---chino-hills-police-department/";

// Permalink forms, in priority order:
//
//  1. https://local.nixle.com/alert/<numeric id>/ — what alert EMAILS actually
//     carry. Verified against live messages 2026-08-17.
//  2. https://nixle.us/<code> — the short link seen on the web channel pages
//     during the 2026-08-12 research pass. Kept as a fallback because it is a
//     real Nixle permalink shape, but no email has been observed using it.
//
// Form 1 is why this scraper ingested nothing for its first four days: it
// required form 2 and silently counted every real press release as service
// mail. Match against the text/plain part first — the HTML part wraps every
// link in AWS `awstrack.me` click tracking with the target percent-encoded,
// which these patterns deliberately do not match (an unwrapped, canonical URL
// is what a reader should get as source_url).
const ALERT_PERMALINK_RE =
	/https?:\/\/(?:www\.)?local\.nixle\.com\/alert\/(\d+)\/?/;
const SHORTLINK_PERMALINK_RE =
	/https?:\/\/(?:www\.)?nixle\.us\/([A-Za-z0-9]{3,12})\b/;

export function extractNixlePermalink(
	text: string,
): { url: string; code: string } | null {
	const alert = text.match(ALERT_PERMALINK_RE);
	if (alert) {
		return {
			url: `https://local.nixle.com/alert/${alert[1]}/`,
			code: alert[1],
		};
	}
	const short = text.match(SHORTLINK_PERMALINK_RE);
	if (short) return { url: `https://nixle.us/${short[1]}`, code: short[1] };
	return null;
}

// Nixle sends each agency's alerts from its own address —
// "SBSD - Headquarters" <sbsd---headquarters@emails.nixle.com> — and the local
// part is the channel slug on local.nixle.com. Deriving the channel per message
// keeps provenance honest: a county-wide release must never be stamped with the
// Chino Hills station's channel URL.
const CHANNEL_SENDER_RE = /([a-z0-9-]+)@emails\.nixle\.com/i;

export function channelFromSender(
	from: string | null,
): { slug: string; url: string } | null {
	const m = (from ?? "").match(CHANNEL_SENDER_RE);
	if (!m) return null;
	const slug = m[1].toLowerCase();
	// Service mail from the platform itself, not an agency channel.
	if (slug === "thenixleteam") return null;
	return { slug, url: `https://local.nixle.com/${slug}/` };
}

// County-wide channels carry releases for the whole of San Bernardino County.
// Relevance is FLAGGED, not filtered at ingest — same policy as sbcfire-news:
// the archive stays complete and the editorial call happens downstream.
const CHINO_RE = /\bchino\b|\bchino hills\b/i;

export interface NixleMessageFields {
	subject: string | null;
	date: Date | null;
	text: string | null;
	html: string | null;
	from: string | null;
	messageId: string | null;
}

export interface NixleItemDraft {
	external_id: string;
	source_url: string;
	title: string;
	body: string;
	occurred_at: string | null;
	meta: Record<string, unknown>;
}

// Pure mapping from parsed message fields to an item draft; null when the
// message carries no Nixle permalink (subscription confirmations, digests,
// service mail) — provenance is non-negotiable, so those are never ingested.
export function messageToItemDraft(
	msg: NixleMessageFields,
): NixleItemDraft | null {
	const permalink =
		extractNixlePermalink(msg.text ?? "") ??
		extractNixlePermalink(msg.html ?? "");
	if (!permalink) return null;
	const subject = (msg.subject ?? "").trim();
	// Nixle subjects carry the priority tag as a prefix. The real emails use
	// "<Type> Message: ..." ("Advisory Message: Deputy Involved Shooting…",
	// observed 2026-08-17); the bare "<Type>: ..." form is accepted too since
	// the web channel pages render it that way. Keep the full subject as title
	// and record the tag separately.
	const priorityMatch = subject.match(
		/^(Alert|Advisory|Community|Traffic)(?:\s+Message)?\s*:/i,
	);
	const body = (msg.text ?? "").trim();
	const channel = channelFromSender(msg.from);
	return {
		external_id: permalink.code,
		source_url: permalink.url,
		title: subject || `Nixle message ${permalink.code}`,
		body,
		occurred_at: msg.date ? msg.date.toISOString() : null,
		meta: {
			channel: channel?.url ?? null,
			channelSlug: channel?.slug ?? null,
			chinoRelevant: CHINO_RE.test(`${subject} ${body}`),
			priority: priorityMatch ? priorityMatch[1].toLowerCase() : null,
			from: msg.from,
			messageId: msg.messageId,
			tier: "C",
		},
	};
}

/**
 * Does this message belong to the Nixle subscription?
 *
 * Exported because of the empty-alias case: NIXLE_MAIL_ALIAS has no default
 * (the address is deployment config, and this repository is public), and a
 * naive `headerAddrs.includes(alias)` is TRUE for every string when alias is
 * "". That would match every message in the mailbox, so an unconfigured alias
 * would silently turn a targeted ingester into one that reads all mail.
 *
 * @param headerAddrs lowercased To/Cc/Delivered-To addresses, joined
 * @param fromText    the From header text
 * @param alias       plus-alias the subscription used, or "" when unset
 */
export function isNixleMessage(
	headerAddrs: string,
	fromText: string,
	alias: string,
): boolean {
	if (alias !== "" && headerAddrs.includes(alias)) return true;
	return fromText.toLowerCase().includes("nixle");
}

function parsedToFields(mail: ParsedMail): NixleMessageFields {
	return {
		subject: mail.subject ?? null,
		date: mail.date ?? null,
		text: mail.text ?? null,
		html: typeof mail.html === "string" ? mail.html : null,
		from: mail.from?.text ?? null,
		messageId: mail.messageId ?? null,
	};
}

function headerAddresses(mail: ParsedMail): string {
	const parts: string[] = [];
	for (const key of ["to", "cc"] as const) {
		const v = mail[key];
		if (!v) continue;
		for (const entry of Array.isArray(v) ? v : [v]) parts.push(entry.text);
	}
	const delivered = mail.headers.get("delivered-to");
	if (typeof delivered === "string") parts.push(delivered);
	return parts.join(" ").toLowerCase();
}

async function run(ctx: ScraperContext): Promise<void> {
	const user = process.env.NIXLE_IMAP_USER;
	const pass = process.env.NIXLE_IMAP_PASSWORD;
	if (!user || !pass) {
		ctx.note(
			"SKIPPED — no mailbox credentials. Set NIXLE_IMAP_USER and NIXLE_IMAP_PASSWORD in .env " +
				"(Gmail app password) to ingest the subscribed Nixle alerts. Not a failure: the " +
				"subscription mailbox is optional per-machine state.",
		);
		return;
	}
	const host = process.env.NIXLE_IMAP_HOST ?? "imap.gmail.com";
	const port = parseInt(process.env.NIXLE_IMAP_PORT ?? "993", 10);
	// No default. The subscribed mailbox is per-deployment configuration, and
	// this repository is public, so the address lives in .env rather than in
	// tracked source. Unset simply means "match on the sender alone", which is
	// the check that actually identifies Nixle mail.
	const alias = (process.env.NIXLE_MAIL_ALIAS ?? "").trim().toLowerCase();
	const sinceDays = parseInt(process.env.NIXLE_MAIL_SINCE_DAYS ?? "90", 10);
	const since = new Date(Date.now() - sinceDays * 86_400_000);

	const client = new ImapFlow({
		host,
		port,
		secure: true,
		auth: { user, pass },
		logger: false,
	});
	await client.connect();
	try {
		const lock = await client.getMailboxLock("INBOX");
		try {
			const searchResult = await client.search({ since }, { uid: true });
			const uids = searchResult === false ? [] : searchResult;
			let matched = 0;
			let ingested = 0;
			let skippedNoPermalink = 0;
			let chinoRelevant = 0;
			const channelCounts = new Map<string, number>();
			for (const uid of uids) {
				const msg = await client.fetchOne(
					String(uid),
					{ source: true },
					{ uid: true },
				);
				// NOT `!msg?.source`: msg is `false | FetchMessageObject`, and optional
				// chaining short-circuits only on null/undefined, so it neither narrows
				// `false` out nor type-checks. Biome's autofix here breaks tsc.
				// biome-ignore lint/complexity/useOptionalChain: union member is `false`, not null/undefined
				if (!msg || !msg.source) continue;
				const mail = await simpleParser(msg.source);
				const fromText = (mail.from?.text ?? "").toLowerCase();
				const isForUs = isNixleMessage(headerAddresses(mail), fromText, alias);
				if (!isForUs) continue;
				matched++;

				const draft = messageToItemDraft(parsedToFields(mail));
				if (!draft) {
					skippedNoPermalink++;
					continue;
				}
				if (draft.meta.chinoRelevant) chinoRelevant++;
				const slug = (draft.meta.channelSlug as string | null) ?? "(unknown)";
				channelCounts.set(slug, (channelCounts.get(slug) ?? 0) + 1);

				// Document = the raw RFC822 message, content-addressed like every
				// other raw artifact; documents.url = the public permalink (where a
				// reader can see this content), which differs from where WE got it —
				// exactly the documents.url vs items.source_url split in PLAN.md.
				const { hash, rawPath } = saveRaw(msg.source, "eml");
				ctx.counts.documentsFetched++;
				const doc = ctx.db.insertDocument({
					source_id: ctx.sourceId,
					url: draft.source_url,
					doc_type: "news_release",
					title: draft.title,
					content_hash: hash,
					raw_path: rawPath,
				});
				if (doc.isNew) ctx.counts.documentsNew++;

				const r = ctx.insertItem({
					document_id: doc.id,
					source_url: draft.source_url,
					item_type: "news_release",
					external_id: draft.external_id,
					title: draft.title,
					body: draft.body,
					occurred_at: draft.occurred_at,
					meta: draft.meta,
				});
				if (r.isNew) ingested++;
			}
			// Say which mode the filter actually ran in. An empty alias is
			// normal (the address is deployment config, not a tracked default),
			// but a run note reading `alias filter ""` invites the reader to
			// think the filter broke.
			const aliasNote =
				alias === ""
					? "no NIXLE_MAIL_ALIAS set, matching on sender only"
					: `alias filter "${alias}"`;
			const channelSummary =
				[...channelCounts]
					.sort((a, b) => b[1] - a[1])
					.map(([slug, n]) => `${slug}=${n}`)
					.join(", ") || "none";
			ctx.note(
				`Mailbox ${user} (${aliasNote}, since ${since.toISOString().slice(0, 10)}): ` +
					`${uids.length} message(s) in window, ${matched} matched Nixle filter, ` +
					`${ingested} new item(s) ingested, ${skippedNoPermalink} matched message(s) skipped for ` +
					`carrying no Nixle permalink (confirmations/service mail — never ingested, provenance rule). ` +
					`Channels seen: ${channelSummary}. ${chinoRelevant} of ${matched - skippedNoPermalink} ` +
					`alert(s) mention Chino/Chino Hills (county-wide channels reach this mailbox too — ` +
					`relevance is flagged in meta, not filtered at ingest).`,
			);
			if (matched === 0) {
				ctx.note(
					"No Nixle messages matched — this means NO MAIL REACHED THE FILTER, not that mail " +
						"arrived and was discarded: mail that arrived without a Nixle permalink is counted " +
						"separately above. The Chino Hills station posts in bursts " +
						"with month-long gaps (see reports/notes/sbsheriff-news.md), so silence here is " +
						"unremarkable; sustained silence is worth checking against the subscription list.",
				);
			}
		} finally {
			lock.release();
		}
	} finally {
		await client.logout().catch(() => client.close());
	}
}

const scraper: ScraperDef = {
	key: "sbsheriff-nixle-mail",
	name: "SB Sheriff Chino Hills station via Nixle (email subscription — ToS-compliant; Tier C)",
	baseUrl: CHANNEL_URL,
	method: "email",
	run,
};

export default scraper;
