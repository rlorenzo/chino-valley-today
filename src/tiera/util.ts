// Shared helpers for Tier A generators: date/timezone handling, slugs, and
// safe markdown embedding of DB-sourced text. Kept dependency-free.

import { createHash } from "node:crypto";

const LA_TZ = "America/Los_Angeles";

function isDateOnly(s: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function pacificDateParts(d: Date): { y: number; m: number; d: number } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: LA_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(d);
	const get = (t: string) =>
		Number(parts.find((p) => p.type === t)?.value ?? "NaN");
	return { y: get("year"), m: get("month"), d: get("day") };
}

// Calendar date (YYYY-MM-DD) in America/Los_Angeles for a full ISO instant.
// Date-only strings pass through unchanged — they already ARE a local
// calendar date with no time-of-day to convert, and re-parsing them as UTC
// midnight and re-projecting to Pacific would shift them a day.
export function localMeetingDate(occurredAt: string): string | null {
	if (isDateOnly(occurredAt)) return occurredAt;
	const d = new Date(occurredAt);
	if (Number.isNaN(d.getTime())) return null;
	const { y, m, d: day } = pacificDateParts(d);
	if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(day)) return null;
	return `${y}-${pad2(m)}-${pad2(day)}`;
}

function todayPacificString(now: Date): string {
	const { y, m, d } = pacificDateParts(now);
	return `${y}-${pad2(m)}-${pad2(d)}`;
}

// "Future" test for meeting-preview candidates. Full ISO instants compare
// directly against the current instant. Date-only meeting dates (no
// time-of-day in the source, e.g. cvusd-board) are treated as future only on
// strictly LATER Pacific calendar days than today — a same-day meeting with
// unknown time is deliberately NOT counted as upcoming, since we cannot
// confirm it hasn't already happened and Tier A must never guess.
export function isFutureOccurredAt(
	occurredAt: string | null,
	now: Date,
): boolean {
	if (!occurredAt) return false;
	if (isDateOnly(occurredAt)) {
		return occurredAt > todayPacificString(now);
	}
	const t = new Date(occurredAt).getTime();
	return !Number.isNaN(t) && t > now.getTime();
}

// Inclusive window test: occurred_at within the last `days` days, and not in
// the future (news/license items shouldn't be forward-dated).
export function withinLastDays(
	occurredAt: string | null,
	now: Date,
	days: number,
): boolean {
	if (!occurredAt) return false;
	const t = new Date(occurredAt).getTime();
	if (Number.isNaN(t)) return false;
	const cutoff = now.getTime() - days * 86400000;
	return t >= cutoff && t <= now.getTime();
}

// Standard ISO-8601 week-number algorithm (Thursday-anchored), operating on
// UTC fields of the Date passed in.
export function isoWeekOf(date: Date): string {
	const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
	const thursday = new Date(date.getTime());
	thursday.setUTCDate(thursday.getUTCDate() - dayNum + 3);
	const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
	const week =
		1 +
		Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
	return `${thursday.getUTCFullYear()}-W${pad2(week)}`;
}

// ISO week label for "now", anchored to Chino Valley's local (Pacific)
// calendar date rather than the server/UTC date, so a late-evening Pacific
// run doesn't land in tomorrow's UTC week.
export function isoWeekForNow(now: Date): string {
	const { y, m, d } = pacificDateParts(now);
	return isoWeekOf(new Date(Date.UTC(y, m - 1, d)));
}

export function slugify(s: string): string {
	const stripped = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	return stripped
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

export function cleanTitle(t: string | null | undefined): string | null {
	if (t == null) return null;
	const trimmed = t.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function truncateTeaser(s: string, max = 140): string {
	const clean = s.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	const cut = clean.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	const base = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
	return `${base.trim()}…`;
}

// Escapes markdown control characters in DB-sourced text so it can never
// alter document structure (e.g. an agenda title containing "]" breaking a
// link, or "*"/"_" creating unintended emphasis). "<" and ">" are included
// because Astro renders raw HTML in markdown unsanitised: a scraped title
// containing a tag would otherwise land on the public site as live markup.
// CommonMark treats a backslash-escaped "<" as literal text, never as HTML.
export function mdEscape(s: string): string {
	return s.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

export function mdLink(text: string, url: string): string {
	return `[${mdEscape(text)}](${url})`;
}

// Keeps the LAST item seen per key (callers iterate in ascending id order,
// so this prefers the most-recently-inserted row for a given key).
export function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
	const map = new Map<string, T>();
	for (const item of items) map.set(keyFn(item), item);
	return [...map.values()];
}

export function humanDateFromLocal(localDate: string): string {
	const d = new Date(`${localDate}T00:00:00Z`);
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "long",
		timeZone: "UTC",
	}).format(d);
}

// The tests assert that unparseable meta is survivable rather than fatal, and
// a row reading literal "null" or "[]" is parseable but just as fatal: the
// property reads below would throw on null. Anything that is not a plain
// object becomes {}.
function parseAlertMeta(meta: string | null): Record<string, unknown> {
	if (!meta) return {};
	try {
		const parsed: unknown = JSON.parse(meta);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

// Compared as instants, never as strings: NWS stamps these with an offset
// ("-07:00") and the same moment written as "Z" sorts earlier lexicographically
// than an offset spelling of itself, which would pick the wrong issuance and
// resurrect exactly the superseded advisory this file exists to suppress.
// Returns null for absent or unparseable values so callers fall back to id.
function alertEffectiveMs(row: { meta: string | null }): number | null {
	const v = parseAlertMeta(row.meta).effective;
	if (typeof v !== "string") return null;
	const t = new Date(v).getTime();
	return Number.isNaN(t) ? null : t;
}

// NWS re-issues an advisory as a series of Updates: same event, same end
// time, same area, a new id every time. Both the brief and the alert-post
// generator keyed on that id, so one Heat Advisory re-issued three times
// rendered three "Active alert" lines and published three near-identical
// posts. A single issuance-window is (event, ends, areaDesc); this is the key
// the post generator wants, because it keeps a post's slug stable across
// re-issues. For what a reader should be told is in force right now, see
// alertEventKey — an extension is not a second advisory.
export function alertAdvisoryKey(row: {
	meta: string | null;
	external_id: string | null;
	source_url: string;
}): string {
	const meta = parseAlertMeta(row.meta);
	const part = (k: string) =>
		typeof meta[k] === "string" ? (meta[k] as string).trim() : "";
	const event = part("event");
	const ends = part("ends");
	const area = part("areaDesc");
	// Without the three identifying fields there is nothing to collapse on;
	// fall back to the issuance so unrelated alerts never merge.
	if (!event || !ends) return `id:${row.external_id ?? row.source_url}`;
	return `${event}|${ends}|${area}`;
}

// Keeps the EARLIEST issuance of each advisory. Deliberately not the latest:
// the alert post's slug is derived from the row that survives here, so
// keeping the first issuance means a re-issue maps to the post that already
// exists instead of minting another one.
export function dedupeAlertIssuances<
	T extends {
		id: number;
		meta: string | null;
		external_id: string | null;
		source_url: string;
	},
>(rows: T[]): T[] {
	const best = new Map<string, T>();
	for (const row of rows) {
		const key = alertAdvisoryKey(row);
		const held = best.get(key);
		if (!held) {
			best.set(key, row);
			continue;
		}
		const a = alertEffectiveMs(row);
		const b = alertEffectiveMs(held);
		if (a !== null && b !== null ? a < b : row.id < held.id) best.set(key, row);
	}
	return [...best.values()];
}

/**
 * The trailing hash in an alert post's slug: sha1 of the issuance the post was
 * generated from. Shared with the daily brief, which uses it to recognise that
 * a published alert post and an "Active alert" line are the same advisory.
 *
 * The two sides cannot be matched on title. The post keeps the EARLIEST
 * issuance so its slug stays stable across re-issues; the brief shows the
 * NEWEST so a reader is told the advisory's current end time. Same advisory,
 * different rows, different titles, so the join has to run through the rows
 * themselves.
 */
export function alertPostSlugHash(row: {
	external_id: string | null;
	source_url: string;
}): string {
	return createHash("sha1")
		.update(row.external_id ?? row.source_url)
		.digest("hex")
		.slice(0, 8);
}

/** The slug generateAlerts gives an alert post: `<date>-<title>-alert-<hash>`. */
export function alertPostSlug(
	dateForSlug: string,
	title: string,
	row: { external_id: string | null; source_url: string },
): string {
	return `${dateForSlug}-${slugify(title)}-alert-${alertPostSlugHash(row)}`;
}

/**
 * The hash back out of a slug alertPostSlug built, or null for a slug it did
 * not build. Kept beside the builder so the two halves of the format cannot
 * drift apart.
 *
 * Nixle posts are alert-typed too and end `-nixle-<hash>`, so matching the
 * `-alert-` marker rather than a bare trailing hash is what keeps them out.
 */
export function alertPostSlugHashOf(slug: string): string | null {
	return /-alert-([0-9a-f]{8})$/.exec(slug)?.[1] ?? null;
}

// The thing NWS keeps updating, without the end time: an advisory that gets
// extended arrives as an Update with a later `ends`, which alertAdvisoryKey
// reads as a second advisory. For a reader that is one advisory whose end time
// moved, so the brief groups on (event, areaDesc) and keeps the newest
// issuance. Distinct products stay distinct: an Extreme Heat Watch alongside a
// Heat Advisory is two different warnings, not a duplicate.
export function alertEventKey(row: {
	meta: string | null;
	external_id: string | null;
	source_url: string;
}): string {
	const meta = parseAlertMeta(row.meta);
	const part = (k: string) =>
		typeof meta[k] === "string" ? (meta[k] as string).trim() : "";
	const event = part("event");
	const area = part("areaDesc");
	// No event name is nothing to group on; fall back to the issuance so
	// unrelated alerts never merge.
	if (!event) return `id:${row.external_id ?? row.source_url}`;
	return `${event}|${area}`;
}

/**
 * A cancellation is not an alert. It is the statement that one has ended.
 *
 * NWS sends the end of an alert as a CAP message with messageType "Cancel"
 * (or "Expire"), carrying the CANCELLED alert's end time in `ends`. Selecting
 * active alerts on `ends > now` therefore keeps it, and on 2026-08-25 the live
 * brief led with "Active alert: The Heat Advisory has been cancelled." beside
 * "Active alert: Extreme Heat Warning issued ... until August 28". Both lines
 * came from the same feed and only one of them was true: the advisory had not
 * been lifted, it had been UPGRADED to the warning. A reader skimming that
 * could reasonably conclude the heat was over on a day forecast above 100F.
 *
 * So a cancellation removes its event and then itself. Two details matter:
 *
 * Grouped by EVENT ALONE, not (event, areaDesc). A cancel routinely lists
 * every zone the original product covered — the Extreme Heat Watch cancel that
 * morning named six areas where the watch itself named one — so an areaDesc
 * key would fail to match the very alert being cancelled. Everything in this
 * feed is already filtered to our forecast zone, so the event name is enough.
 *
 * Only issuances OLDER than the cancel are removed. NWS can cancel an advisory
 * and issue a fresh one of the same name minutes later; suppressing by name
 * alone would hide the new one, and hiding a live heat advisory is the same
 * class of harm as inventing a cancelled one.
 */
export function dropCancelledAlerts<
	T extends {
		id: number;
		meta: string | null;
		external_id: string | null;
		source_url: string;
	},
>(rows: T[]): T[] {
	const isCancellation = (row: T): boolean => {
		const type = parseAlertMeta(row.meta).messageType;
		return type === "Cancel" || type === "Expire";
	};
	const eventName = (row: T): string => {
		const event = parseAlertMeta(row.meta).event;
		return typeof event === "string" ? event.trim() : "";
	};

	// Newest cancellation per event. Rows with no usable timestamp fall back to
	// insertion order, the same way dropSupersededAlerts breaks that tie.
	const cancelled = new Map<string, T>();
	for (const row of rows) {
		if (!isCancellation(row)) continue;
		const event = eventName(row);
		if (!event) continue;
		const held = cancelled.get(event);
		if (!held) {
			cancelled.set(event, row);
			continue;
		}
		const a = alertEffectiveMs(row);
		const b = alertEffectiveMs(held);
		if (a !== null && b !== null ? a > b : row.id > held.id) {
			cancelled.set(event, row);
		}
	}

	return rows.filter((row) => {
		if (isCancellation(row)) return false;
		const cancel = cancelled.get(eventName(row));
		if (!cancel) return true;
		const rowMs = alertEffectiveMs(row);
		const cancelMs = alertEffectiveMs(cancel);
		if (rowMs !== null && cancelMs !== null) return rowMs > cancelMs;
		return row.id > cancel.id;
	});
}

/**
 * One line per alert a reader should act on: the newest issuance of each
 * (event, areaDesc). Superseded issuances drop out, so an extended advisory
 * reads as one advisory with its current end time rather than as the old
 * window sitting beside the new one.
 */
export function dropSupersededAlerts<
	T extends {
		id: number;
		meta: string | null;
		external_id: string | null;
		source_url: string;
	},
>(rows: T[]): T[] {
	const best = new Map<string, T>();
	for (const row of rows) {
		const key = alertEventKey(row);
		const held = best.get(key);
		if (!held) {
			best.set(key, row);
			continue;
		}
		const a = alertEffectiveMs(row);
		const b = alertEffectiveMs(held);
		// Newest issuance wins; without usable timestamps the later row does,
		// since alerts are inserted in the order the feed lists them.
		if (a !== null && b !== null ? a > b : row.id > held.id) best.set(key, row);
	}
	return [...best.values()];
}
