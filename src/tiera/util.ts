// Shared helpers for Tier A generators: date/timezone handling, slugs, and
// safe markdown embedding of DB-sourced text. Kept dependency-free.

const LA_TZ = "America/Los_Angeles";

export function isDateOnly(s: string): boolean {
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
// link, or "*"/"_" creating unintended emphasis).
export function mdEscape(s: string): string {
	return s.replace(/[\\`*_[\]]/g, (c) => `\\${c}`);
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
