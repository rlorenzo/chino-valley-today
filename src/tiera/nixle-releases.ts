// Post type 5: agency press releases from subscribed Nixle channels.
//
// Editorial basis: EDITORIAL.md "Agency alert channels (amended 2026-08-17)".
// These items are stored Tier C (they name private individuals), but the
// operator decided on 2026-08-17 that releases from a subscribed agency channel
// publish in full without the per-item acknowledgment Tier C otherwise
// requires — the agency has already published the text itself, and we
// redistribute it verbatim. Read that section before changing anything here.
//
// The post is Tier A because the RENDERING is Tier A: zero LLM calls, the
// agency's own words in an attributed blockquote, nothing characterized. The
// three guards below are the conditions the amendment attached to that
// decision, and they are deterministic on purpose — a guard that needs
// judgment is a guard that needs a human, which is what was traded away.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import type { NewPost } from "../pipeline/posts.ts";
import { parseMeta, queryItems } from "./queries.ts";
import {
	cleanTitle,
	localMeetingDate,
	mdEscape,
	mdLink,
	slugify,
	withinLastDays,
} from "./util.ts";

const SOURCE_KEY = "sbsheriff-nixle-mail";

// Only recent releases publish. Without this, the first run after a mailbox
// backfill would publish months of releases at once, all dated today from a
// reader's point of view.
const MAX_AGE_DAYS = 30;

// Minors guard (EDITORIAL.md "Private persons": never named, never identifiably
// described, even when the source document names them — the rule names Sheriff
// releases explicitly, because those DO name them).
//
// Two signals, kept narrow on purpose. An earlier draft matched any
// "<n>-year-old" and so held 40-year-old suspects too, which would have held
// nearly every adult release and quietly undone the auto-publish decision. A
// guard that fires on everything is not a safe guard, it is a broken one:
// people stop reading its output.
const EXPLICIT_MINOR_RE =
	/\b(?:juveniles?|minors?|child(?:ren)?|teen(?:ager)?s?|youths?|infants?|toddlers?|newborns?|bab(?:y|ies)|boys?|girls?|high\s+school|middle\s+school|elementary)\b/i;
const AGE_RE = /\b(\d{1,2})[-\s]years?[-\s]old\b/gi;

// Local place names that collide with the minors vocabulary, removed before the
// guard runs. **Boys Republic** is a real institution in Chino Hills with a
// street named after it — a routine adult collision report on Boys Republic
// Drive is exactly the kind of local release this source exists to publish, and
// holding it as a minors item would be the over-firing failure described above,
// concentrated on our own coverage area. Boys & Girls Club is the same problem.
// Scrubbing the place name is safer than weakening `boys?|girls?`, which
// carries real signal ("the boy was found safe").
const PLACE_NAME_RE =
	/\bboys\s+republic\b|\bboys\s*(?:&|and)\s*girls\s+club\b/gi;

/** True when the text indicates a minor is involved. Exported for testing. */
export function mentionsMinor(text: string): boolean {
	const scrubbed = text.replace(PLACE_NAME_RE, " ");
	if (EXPLICIT_MINOR_RE.test(scrubbed)) return true;
	for (const m of scrubbed.matchAll(AGE_RE)) {
		if (Number(m[1]) < 18) return true;
	}
	return false;
}

// A release is publishable only if the ingester flagged it as mentioning Chino
// or Chino Hills. County-wide channels (SBSD - Headquarters, SBSD - Central)
// deliver here too and carry releases for cities 60 miles away.
function isChinoRelevant(meta: Record<string, unknown>): boolean {
	return meta.chinoRelevant === true;
}

interface GenResult {
	posts: NewPost[];
	notes: string[];
}

/** Strip Nixle's "Advisory Message:" style prefix for the post title. */
export function stripPriorityPrefix(subject: string): string {
	return subject
		.replace(/^(?:Alert|Advisory|Community|Traffic)(?:\s+Message)?\s*:\s*/i, "")
		.trim();
}

/**
 * Nixle bodies open with a fixed template preamble ("Dear Nixle User, /
 * <Type> Message has been issued by the <agency>. / <timestamp> / <headline>")
 * before the release proper. Dropping it keeps the blockquote to the agency's
 * actual words rather than the mailing-list chrome. Anything unrecognized is
 * left alone — never guess at trimming a source document.
 */
export function stripMailPreamble(body: string): string {
	const lines = body.split(/\r?\n/);
	let start = 0;
	for (let i = 0; i < Math.min(lines.length, 8); i++) {
		const l = lines[i].trim();
		if (
			/^dear nixle user,?$/i.test(l) ||
			/message has been issued by the/i.test(l) ||
			/^[A-Z][a-z]+day\s+\w+\s+\d{1,2},?\s+\d{4}/.test(l)
		) {
			start = i + 1;
		}
	}
	return lines.slice(start).join("\n").trim();
}

export function generateNixleReleases(db: Db, now: Date): GenResult {
	const items = queryItems(db, { sourceKeys: [SOURCE_KEY] });
	const posts: NewPost[] = [];
	const notes: string[] = [];
	let offArea = 0;
	let stale = 0;
	let heldMinor = 0;
	const heldSlugs: string[] = [];

	for (const row of items) {
		const meta = parseMeta(row.meta);

		if (!isChinoRelevant(meta)) {
			offArea++;
			continue;
		}
		if (
			!row.occurred_at ||
			!withinLastDays(row.occurred_at, now, MAX_AGE_DAYS)
		) {
			stale++;
			continue;
		}

		const subject = cleanTitle(row.title) ?? "";
		// Read for the guard below, never rendered. We still have to know what
		// the release says in order to decide whether a human must see it —
		// EDITORIAL.md makes anything involving a minor Tier C regardless of how
		// we choose to present it, and "we only linked to it" is not an
		// exemption the rule offers.
		const body = stripMailPreamble(row.body ?? "");

		// Minors guard. The post is still BUILT — it is routed to the held queue
		// via heldReason below, not skipped. Skipping it produced a hold that
		// existed only as a line in the run log: the dashboard's held queue reads
		// posts, so with no post row there was nothing for a human to review, and
		// the "held for human review" note pointed at a queue that stayed empty.
		const minor = mentionsMinor(`${subject} ${body}`);
		if (minor) {
			heldMinor++;
			heldSlugs.push(row.external_id ?? row.source_url);
		}

		const headline = stripPriorityPrefix(subject) || "Sheriff's release";
		const localDate =
			localMeetingDate(row.occurred_at) ?? now.toISOString().slice(0, 10);
		const hash = createHash("sha1")
			.update(row.external_id ?? row.source_url)
			.digest("hex")
			.slice(0, 8);

		const agency =
			typeof meta.channelSlug === "string"
				? meta.channelSlug.replace(/-{2,}/g, " — ").replace(/-/g, " ")
				: "San Bernardino County Sheriff's Department";
		const priority = typeof meta.priority === "string" ? meta.priority : null;

		// Headline and link ONLY. The release body is never rendered.
		//
		// Two reasons, either sufficient on its own:
		//
		// 1. Private individuals. Bodies carry "SUSPECT1: <name>, Age <n>,
		//    <city> Resident" lines, victims, and witnesses. Publishing them
		//    verbatim put every one of those on the site; a headline names
		//    nobody, and readers who want the detail follow the agency's own
		//    link to the agency's own page.
		// 2. Credentials. Every message ends with a per-recipient account link
		//    carrying the subscription id, the mailbox address and an auth
		//    token (.../settings/subscription/<id>/<email>/<token>/). Rendering
		//    the body verbatim would have published the operator's email and a
		//    live token able to alter the subscription.
		//
		// This is the same shape as the fire & safety section of the daily
		// brief (src/pipeline/daily-brief.ts): verbatim title, source link,
		// never body text.
		const lines: string[] = [];
		lines.push(`- **Issued by:** ${mdEscape(agency)}`);
		if (priority) lines.push(`- **Priority:** ${mdEscape(priority)}`);
		lines.push(`- **Issued:** ${mdEscape(row.occurred_at)}`, "");
		lines.push(
			"This is the agency's own headline. Full details, including any names the department chose to release, are on its page:",
			"",
		);
		lines.push(mdLink("Read the full release (Nixle)", row.source_url));

		posts.push({
			slug: `${localDate}-${slugify(headline)}-nixle-${hash}`,
			postType: "alert",
			// A held post is Tier C: it reached a human precisely because the
			// verbatim-render exemption did not cover it. Published ones stay Tier
			// A — deterministic render, no LLM (EDITORIAL.md "Agency alert
			// channels"). The badge a reviewer sees should say which one it is.
			tier: minor ? "C" : "A",
			title: headline,
			bodyMd: lines.join("\n"),
			sources: [row.source_url],
			...(minor
				? {
						heldReason:
							"minors guard: the release text indicates a minor is involved " +
							"(EDITORIAL.md 'Private persons' — never named or identifiably " +
							"described, even when the source document names them)",
					}
				: {}),
		});
	}

	notes.push(
		`${items.length} Nixle item(s) in DB -> ${posts.length} post(s) ` +
			`(${posts.length - heldMinor} to publish, ${heldMinor} to the held queue). ` +
			`Filtered: ${offArea} not Chino-relevant (county-wide channels), ` +
			`${stale} older than ${MAX_AGE_DAYS} days.`,
	);
	if (heldMinor > 0) {
		notes.push(
			`HELD for human review in the admin dashboard (minors guard, ` +
				`EDITORIAL.md "Private persons"): ${heldSlugs.join(", ")}`,
		);
	}
	return { posts, notes };
}
