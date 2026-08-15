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
// (chinovalleytoday+nixle@gmail.com, subscribed 2026-08-13). Each message
// carries a nixle.us short-link permalink; that public URL — not the mailbox —
// is what readers get as source_url.
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
//   NIXLE_IMAP_USER      mailbox login (e.g. chinovalleytoday@gmail.com)
//   NIXLE_IMAP_PASSWORD  app password (Gmail: Account -> Security -> 2-Step
//                        Verification -> App passwords)
//   NIXLE_IMAP_HOST      default imap.gmail.com
//   NIXLE_IMAP_PORT      default 993
//   NIXLE_MAIL_ALIAS     default chinovalleytoday+nixle@gmail.com — messages
//                        are matched on To/Cc/Delivered-To containing this,
//                        OR a sender containing "nixle"
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

const CHANNEL_URL =
	"https://local.nixle.com/sbsd---chino-hills-police-department/";

// nixle.us short-link permalink carried in each alert message (observed form:
// https://nixle.us/HG583). Case-sensitive code; tolerate an optional www.
const NIXLE_PERMALINK_RE =
	/https?:\/\/(?:www\.)?nixle\.us\/([A-Za-z0-9]{3,12})\b/;

export function extractNixlePermalink(
	text: string,
): { url: string; code: string } | null {
	const m = text.match(NIXLE_PERMALINK_RE);
	if (!m) return null;
	return { url: `https://nixle.us/${m[1]}`, code: m[1] };
}

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
// message carries no nixle.us permalink (subscription confirmations, digests,
// service mail) — provenance is non-negotiable, so those are never ingested.
export function messageToItemDraft(
	msg: NixleMessageFields,
): NixleItemDraft | null {
	const permalink =
		extractNixlePermalink(msg.text ?? "") ??
		extractNixlePermalink(msg.html ?? "");
	if (!permalink) return null;
	const subject = (msg.subject ?? "").trim();
	// Nixle subjects carry the priority tag as a prefix ("Advisory: ...",
	// "Alert: ...", "Community: ..."); keep the full subject as title and
	// record the tag separately when present.
	const priorityMatch = subject.match(
		/^(Alert|Advisory|Community|Traffic)\s*:/i,
	);
	const body = (msg.text ?? "").trim();
	return {
		external_id: permalink.code,
		source_url: permalink.url,
		title: subject || `Nixle message ${permalink.code}`,
		body,
		occurred_at: msg.date ? msg.date.toISOString() : null,
		meta: {
			channel: CHANNEL_URL,
			priority: priorityMatch ? priorityMatch[1].toLowerCase() : null,
			from: msg.from,
			messageId: msg.messageId,
			tier: "C",
		},
	};
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
	const alias = (
		process.env.NIXLE_MAIL_ALIAS ?? "chinovalleytoday+nixle@gmail.com"
	).toLowerCase();
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
				const isForUs =
					headerAddresses(mail).includes(alias) || fromText.includes("nixle");
				if (!isForUs) continue;
				matched++;

				const draft = messageToItemDraft(parsedToFields(mail));
				if (!draft) {
					skippedNoPermalink++;
					continue;
				}

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
			ctx.note(
				`Mailbox ${user} (alias filter "${alias}", since ${since.toISOString().slice(0, 10)}): ` +
					`${uids.length} message(s) in window, ${matched} matched Nixle filter, ` +
					`${ingested} new item(s) ingested, ${skippedNoPermalink} matched message(s) skipped for ` +
					`carrying no nixle.us permalink (confirmations/service mail — never ingested, provenance rule).`,
			);
			if (matched === 0) {
				ctx.note(
					"No Nixle messages found yet — expected until the first alert lands (channel cadence is " +
						"roughly one message per 1-2 weeks; see reports/notes/sbsheriff-news.md).",
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
