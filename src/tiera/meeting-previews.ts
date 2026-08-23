// Post type 1: meeting previews. One post per UPCOMING meeting found in the
// DB, built entirely from structured fields — dates/times/locations come
// from item meta verbatim, agenda items (when they already exist in the DB
// for that meeting) are quoted verbatim with their own source_url. A
// template that only quotes and links cannot hallucinate.
import type { Db } from "../db/index.ts";
import type { NewPost } from "../pipeline/posts.ts";
import { type ItemRow, parseMeta, queryItems } from "./queries.ts";
import {
	cleanTitle,
	dedupeByKey,
	humanDateFromLocal,
	isFutureOccurredAt,
	localMeetingDate,
	mdEscape,
	mdLink,
	slugify,
} from "./util.ts";

interface GenResult {
	posts: NewPost[];
	notes: string[];
}

function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// Deliberately permissive (substring containment either direction): the two
// sides come from different scrapers with different naming conventions
// ("City Council" vs "City Council Regular"), and a false negative here just
// means the preview falls back to a meeting-page link, never a wrong claim.
function bodiesMatch(a: string, b: string): boolean {
	const na = normalizeForMatch(a);
	const nb = normalizeForMatch(b);
	if (!na || !nb) return false;
	return na === nb || na.includes(nb) || nb.includes(na);
}

function agendaBodyName(
	row: ItemRow,
	meta: Record<string, unknown>,
): string | null {
	if (
		row.source_key === "chino-legistar" &&
		typeof meta.eventBodyName === "string"
	)
		return meta.eventBodyName;
	if (
		(row.source_key === "chino-agendacenter" ||
			row.source_key === "chinohills-agendas") &&
		typeof meta.body === "string"
	) {
		return meta.body;
	}
	return null;
}

function findMatchingAgendaItems(
	agendaItems: ItemRow[],
	localDate: string,
	bodyName: string,
): ItemRow[] {
	return agendaItems.filter((row) => {
		if (!row.occurred_at) return false;
		if (localMeetingDate(row.occurred_at) !== localDate) return false;
		const rowBody = agendaBodyName(row, parseMeta(row.meta));
		return rowBody ? bodiesMatch(rowBody, bodyName) : false;
	});
}

function agendaSortKey(row: ItemRow): number {
	const meta = parseMeta(row.meta);
	const raw = meta.agendaSequence ?? meta.agendaNumber;
	const n = Number(raw);
	return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

// Renders the numbered agenda list (verbatim titles, each linking its own
// source_url); returns '' when no item has a usable title.
function agendaListMarkdown(items: ItemRow[]): string {
	const sorted = [...items].sort(
		(a, b) => agendaSortKey(a) - agendaSortKey(b) || a.id - b.id,
	);
	const lines = sorted
		.map((row) => {
			const title = cleanTitle(row.title);
			return title ? mdLink(title, row.source_url) : null;
		})
		.filter((l): l is string => l !== null);
	return lines.length ? lines.map((l) => `1. ${l}`).join("\n") : "";
}

function sourcesFrom(rows: ItemRow[]): string[] {
	return dedupeByKey(
		rows.map((r) => ({ url: r.source_url })),
		(r) => r.url,
	).map((r) => r.url);
}

/**
 * The classification signals behind a preview: which sources it was built from
 * and which item types. Passed to createPost so topic filing reads the record
 * the post came from rather than the wording of its title.
 */
function signalsFrom(rows: ItemRow[]): {
	sourceKeys: string[];
	itemTypes: string[];
} {
	return {
		sourceKeys: [...new Set(rows.map((r) => r.source_key))],
		itemTypes: [...new Set(rows.map((r) => r.item_type))],
	};
}

// ---- Candidate A: chino-news-rss city calendar ('event' items) ----

function chinoCalendarBodyName(rawTitle: string): {
	cancelled: boolean;
	body: string;
} {
	let t = rawTitle.trim();
	let cancelled = false;
	const cancelMatch = /^CANCELLED\s+/i.exec(t);
	if (cancelMatch) {
		cancelled = true;
		t = t.slice(cancelMatch[0].length);
	}
	t = t
		.replace(/\s*-\s*Regular Meeting$/i, "")
		.replace(/\s*Meeting$/i, "")
		.trim();
	return { cancelled, body: t };
}

// Both calendar-style generators open identically: pull the source's 'event'
// items, drop the untitled and the already-past, and keep the raw total for the
// run note. `total` is every event item in the DB for that source, which is what
// makes the note ("N upcoming of M total") meaningful.
function upcomingEvents(
	db: Db,
	sourceKey: string,
	now: Date,
): { upcoming: Array<{ row: ItemRow; title: string }>; total: number } {
	const events = queryItems(db, {
		sourceKeys: [sourceKey],
		itemTypes: ["event"],
	});
	const upcoming: Array<{ row: ItemRow; title: string }> = [];
	for (const row of events) {
		const title = cleanTitle(row.title);
		if (!title) continue;
		if (!isFutureOccurredAt(row.occurred_at, now)) continue;
		upcoming.push({ row, title });
	}
	return { upcoming, total: events.length };
}

// The City of Chino's calendar feed publishes two rendering artifacts that are
// its own, not ours. The raw archive keeps them verbatim (faithful archive);
// these normalise at the PUBLISHING layer, which is where EDITORIAL.md says the
// rules bite.
//
// 1. Location arrives with the street run into the city: "13220 Central
//    AvenueChino, CA 91710" — their HTML-to-text lost a line break.
// 2. An end time of 11:59 PM is their convention for "no end specified", not a
//    six-hour meeting. Publishing it as a real end time states something the
//    source does not mean.
const STREET_SUFFIX =
	/(Avenue|Ave|Street|St|Boulevard|Blvd|Drive|Dr|Road|Rd|Way|Lane|Ln|Court|Ct|Place|Pl|Parkway|Pkwy)(?=[A-Z])/g;

export function normalizeLocation(raw: string | null): string | null {
	if (!raw) return null;
	return raw
		.replace(STREET_SUFFIX, "$1, ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

export function normalizeTimes(raw: string | null): string | null {
	if (!raw) return null;
	const openEnded = raw.match(/^(.*?)\s*[-–]\s*11:59\s*PM\s*$/i);
	return (openEnded ? openEnded[1] : raw).trim() || null;
}

// meta values arrive as unknown from JSON; every caller wants "the string, or
// nothing". Repeating the typeof guard inline obscured the branching in the
// preview builders.
function metaString(meta: Record<string, unknown>, key: string): string | null {
	const v = meta[key];
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

// The markdown body for one Chino calendar preview.
//
// Gate 1a requires every fact-bearing line to carry its own citation, so each
// bullet repeats the calendar link rather than sharing one below — that rule is
// what makes this long and branchy, and why it is worth its own function.
function chinoCalendarPreviewBody(opts: {
	cancelled: boolean;
	sourceUrl: string;
	eventDates: string | null;
	eventTimes: string | null;
	location: string | null;
	matched: ItemRow[];
}): string {
	const cite = (label: string) => mdLink(label, opts.sourceUrl);
	const lines: string[] = [];

	if (opts.cancelled) {
		lines.push(
			`**This meeting has been CANCELLED** (${cite("city calendar")}).`,
			"",
		);
	}

	const details: Array<[string, string | null]> = [
		["Date", opts.eventDates],
		["Time", opts.eventTimes],
		["Location", opts.location],
	];
	const detailLines = details
		.filter(([, value]) => value !== null)
		.map(
			([label, value]) =>
				`- **${label}:** ${mdEscape(value as string)} (${cite("calendar")})`,
		);
	if (detailLines.length) lines.push(...detailLines, "");

	lines.push(cite("City calendar entry"));

	if (!opts.cancelled) {
		const agendaMd = agendaListMarkdown(opts.matched);
		lines.push("");
		if (agendaMd) {
			lines.push("### Agenda", "", agendaMd);
		} else {
			lines.push(
				`_No agenda had been posted to our records as of publish time (${cite("calendar")})._`,
			);
		}
	}

	return lines.join("\n");
}

function genChinoCalendarPreviews(
	db: Db,
	now: Date,
	crossRefAgendaItems: ItemRow[],
): GenResult {
	const { upcoming, total } = upcomingEvents(db, "chino-news-rss", now);
	const notes: string[] = [];
	const posts: NewPost[] = [];

	for (const { row, title } of upcoming) {
		const localDate = localMeetingDate(row.occurred_at as string);
		if (!localDate) {
			notes.push(
				`Skipped calendar event "${title}": occurred_at "${row.occurred_at}" did not parse to a calendar date.`,
			);
			continue;
		}

		const { cancelled, body } = chinoCalendarBodyName(title);
		const meta = parseMeta(row.meta);
		const eventDates = metaString(meta, "eventDates");
		const matched = cancelled
			? []
			: findMatchingAgendaItems(crossRefAgendaItems, localDate, body);

		const bodyMd = chinoCalendarPreviewBody({
			cancelled,
			sourceUrl: row.source_url,
			eventDates,
			eventTimes: normalizeTimes(metaString(meta, "eventTimes")),
			location: normalizeLocation(metaString(meta, "location")),
			matched,
		});

		const humanDate = eventDates ?? humanDateFromLocal(localDate);
		posts.push({
			slug: `${localDate}-chino-${slugify(body)}-preview`,
			postType: "meeting_preview",
			tier: "A",
			title: cancelled
				? `CANCELLED: ${body} — ${humanDate}`
				: `Meeting Preview: ${body} — ${humanDate}`,
			bodyMd,
			meetingDate: localDate,
			sources: sourcesFrom([row, ...matched]),
			...signalsFrom([row, ...matched]),
		});
	}

	notes.push(
		`chino-news-rss calendar: ${upcoming.length} upcoming event(s) found (of ${total} total calendar 'event' items in DB) -> ${posts.length} preview post(s).`,
	);
	return { posts, notes };
}

// ---- Candidate B: cvusd-board 'event' items ----

function genCvusdPreviews(db: Db, now: Date): GenResult {
	const { upcoming, total } = upcomingEvents(db, "cvusd-board", now);
	const notes: string[] = [];
	const posts: NewPost[] = [];

	// `title` is only a presence guard for this source — upcomingEvents already
	// dropped the untitled rows, and the post title below is a fixed string.
	for (const { row } of upcoming) {
		const localDate = row.occurred_at as string; // already a bare YYYY-MM-DD
		const meta = parseMeta(row.meta);
		const meetingType =
			typeof meta.meetingType === "string" ? meta.meetingType : null;
		const agendaUrl =
			typeof meta.agendaUrl === "string" ? meta.agendaUrl : null;
		const videoUrl = typeof meta.videoUrl === "string" ? meta.videoUrl : null;

		const lines: string[] = [
			`- **Date:** ${mdEscape(localDate)} (${mdLink("board meeting page", row.source_url)})`,
		];
		if (meetingType) {
			lines.push(
				`- **Meeting type:** ${mdEscape(meetingType)} (${mdLink("board meeting page", row.source_url)})`,
			);
		}
		lines.push("", mdLink("Board meeting page", row.source_url));
		if (agendaUrl && agendaUrl !== row.source_url)
			lines.push("", mdLink("Agenda", agendaUrl));
		if (videoUrl) lines.push("", mdLink("Video", videoUrl));
		lines.push(
			"",
			"_No agenda item text is in our records for this meeting — CVUSD's agenda PDF host " +
				`currently blocks automated fetching (robots.txt); see the ${
					agendaUrl
						? mdLink("agenda", agendaUrl)
						: mdLink("board meeting page", row.source_url)
				}._`,
		);

		const sourceUrls = dedupeByKey(
			[row.source_url, agendaUrl]
				.filter((u): u is string => !!u)
				.map((u) => ({ url: u })),
			(r) => r.url,
		).map((r) => r.url);

		posts.push({
			slug: `${localDate}-cvusd-board-of-education-preview`,
			postType: "meeting_preview",
			tier: "A",
			title: `Meeting Preview: CVUSD Board of Education — ${humanDateFromLocal(localDate)}`,
			bodyMd: lines.join("\n"),
			meetingDate: localDate,
			sources: sourceUrls,
			...signalsFrom([row]),
		});
	}

	notes.push(
		`cvusd-board: ${upcoming.length} upcoming event(s) found (of ${total} total 'event' items in DB) -> ${posts.length} preview post(s).`,
	);
	return { posts, notes };
}

// ---- Candidate C: chino-legistar future events WITH agenda items ----

function genLegistarPreviews(
	now: Date,
	legistarAgendaItems: ItemRow[],
): GenResult {
	const notes: string[] = [];
	const posts: NewPost[] = [];

	const groups = new Map<string, ItemRow[]>();
	for (const row of legistarAgendaItems) {
		const meta = parseMeta(row.meta);
		if (meta.eventId == null) continue;
		const key = String(meta.eventId);
		const arr = groups.get(key) ?? [];
		arr.push(row);
		groups.set(key, arr);
	}

	let futureGroups = 0;
	for (const [eventId, rows] of groups) {
		const occurredAt = rows[0]?.occurred_at ?? null;
		if (!isFutureOccurredAt(occurredAt, now)) continue;
		futureGroups++;

		const localDate = localMeetingDate(occurredAt as string);
		if (!localDate) {
			notes.push(
				`Skipped Legistar EventId ${eventId}: occurred_at "${occurredAt}" did not parse.`,
			);
			continue;
		}
		const meta0 = parseMeta(rows[0]?.meta);
		const eventBodyName =
			typeof meta0.eventBodyName === "string"
				? meta0.eventBodyName
				: `Meeting ${eventId}`;

		const agendaMd = agendaListMarkdown(rows);
		const lines: string[] = [
			`- **Date:** ${mdEscape(humanDateFromLocal(localDate))} (${mdLink("meeting record", rows[0]?.source_url)})`,
			"",
		];
		if (agendaMd) {
			lines.push("### Agenda", "", agendaMd);
		} else {
			lines.push(
				`_No agenda items are in our records for this meeting yet (${mdLink("meeting record", rows[0]?.source_url)})._`,
			);
		}

		posts.push({
			slug: `${localDate}-chino-${slugify(eventBodyName)}-preview`,
			postType: "meeting_preview",
			tier: "A",
			title: `Meeting Preview: ${eventBodyName} — ${humanDateFromLocal(localDate)}`,
			bodyMd: lines.join("\n"),
			meetingDate: localDate,
			sources: sourcesFrom(rows),
			...signalsFrom(rows),
		});
	}

	notes.push(
		`chino-legistar: ${futureGroups} upcoming meeting(s) with agenda items found (of ${groups.size} distinct meetings in DB) -> ${posts.length} preview post(s).`,
	);
	return { posts, notes };
}

// ---- Candidate D: chinohills-agendas future meetings WITH agenda items ----
//
// chinohills-agendas' occurred_at is date-only (no time-of-day anywhere in
// the source — see chinohills-agendas.ts). Per team-lead decision
// 2026-08-12: STRICT future-only rule — a meeting is previewed only when its
// Pacific calendar date is strictly after today's; same-day meetings are
// NEVER previewed, because a bare date can't tell us whether the meeting has
// already happened, and PLAN.md's previews are meant to publish T-1 day
// anyway (a same-day preview is too late to be useful even when correct).
// isFutureOccurredAt() already encodes exactly this rule for date-only
// strings, so no special-casing is needed here beyond using it.
function genChinohillsAgendaPreviews(
	now: Date,
	chinohillsAgendaItems: ItemRow[],
): GenResult {
	const notes: string[] = [];
	const posts: NewPost[] = [];

	// Group by meta.seq — chinohills-agendas.ts's AgendaQuick meeting sequence
	// id, the stable per-meeting identity for this source (distinct meeting
	// bodies can share a date; seq does not).
	const groups = new Map<string, ItemRow[]>();
	for (const row of chinohillsAgendaItems) {
		const meta = parseMeta(row.meta);
		if (meta.seq == null) continue;
		const key = String(meta.seq);
		const arr = groups.get(key) ?? [];
		arr.push(row);
		groups.set(key, arr);
	}

	let futureGroups = 0;
	for (const [seq, rows] of groups) {
		const occurredAt = rows[0]?.occurred_at ?? null;
		if (!isFutureOccurredAt(occurredAt, now)) continue;
		futureGroups++;

		const localDate = occurredAt as string; // already a bare YYYY-MM-DD
		const meta0 = parseMeta(rows[0]?.meta);
		const bodyName =
			typeof meta0.body === "string" ? meta0.body : `Meeting seq ${seq}`;

		const agendaMd = agendaListMarkdown(rows);
		const lines: string[] = [
			`- **Date:** ${mdEscape(humanDateFromLocal(localDate))} (${mdLink("agenda packet", rows[0]?.source_url)})`,
			"",
		];
		if (agendaMd) {
			lines.push("### Agenda", "", agendaMd);
		} else {
			lines.push(
				`_No agenda items are in our records for this meeting yet (${mdLink("agenda packet", rows[0]?.source_url)})._`,
			);
		}

		posts.push({
			slug: `${localDate}-chinohills-${slugify(bodyName)}-preview`,
			postType: "meeting_preview",
			tier: "A",
			title: `Meeting Preview: ${bodyName} — ${humanDateFromLocal(localDate)}`,
			bodyMd: lines.join("\n"),
			meetingDate: localDate,
			sources: sourcesFrom(rows),
			...signalsFrom(rows),
		});
	}

	notes.push(
		`chinohills-agendas: ${futureGroups} upcoming meeting(s) with agenda items found (of ${groups.size} distinct meetings in DB) -> ${posts.length} preview post(s). Same-day meetings are never previewed (no time-of-day data in this source — strict future-only rule).`,
	);
	return { posts, notes };
}

export function generateMeetingPreviews(db: Db, now: Date): GenResult {
	const legistarAgendaItems = queryItems(db, {
		sourceKeys: ["chino-legistar"],
		itemTypes: ["agenda_item"],
	});
	const agendacenterAgendaItems = queryItems(db, {
		sourceKeys: ["chino-agendacenter"],
		itemTypes: ["agenda_item"],
	});
	const chinohillsAgendaItems = queryItems(db, {
		sourceKeys: ["chinohills-agendas"],
		itemTypes: ["agenda_item"],
	});
	const crossRefAgendaItems = [
		...legistarAgendaItems,
		...agendacenterAgendaItems,
		...chinohillsAgendaItems,
	];

	const a = genChinoCalendarPreviews(db, now, crossRefAgendaItems);
	const b = genCvusdPreviews(db, now);
	const c = genLegistarPreviews(now, legistarAgendaItems);
	const d = genChinohillsAgendaPreviews(now, chinohillsAgendaItems);

	return {
		posts: [...a.posts, ...b.posts, ...c.posts, ...d.posts],
		notes: [...a.notes, ...b.notes, ...c.notes, ...d.notes],
	};
}
