// Chino Valley USD calendars — district plus the four comprehensive high
// schools, via the CMS's own unauthenticated JSON API.
//
// This is the source that finally reaches school performing arts: the Ayala
// feed alone carries Madrigal Feast (four performances), the Winter and Jazz
// concerts, ITS Showcase and Music in Motion. None of that appears anywhere
// else the brief reads.
//
// ENDPOINT DISCOVERY (2026-09-04). The district runs ParentSquare's SmartSites
// CMS. Its calendar page renders an EMPTY container
// (<div id="full-page-calendar134999" data-calendar="134999">) and populates it
// client-side, so the HTML is worthless. Every RSS/iCal convention was probed
// and none exists: /rss, /feed, /site/RSS.aspx, /ical, /calendar.ics,
// /events.ics, /api/calendar, /api/events all 404 or 400, and /calendar/feed
// 302s to a login. The working endpoint came from reading the page's OWN
// bundled JS (/dist/assets/EventsRepository-*.js), which calls:
//
//   GET https://<host>/api/calendars/<id>/events
//         ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&view_source=event-slider
//
// It needs no auth, no cookie and no token, and returns
// { success, data: { events: [...] } }. There is no public ParentSquare API
// involved — this is the district's own domain serving its own CMS backend.
//
// robots.txt (www.chino.k12.ca.us, and identical on the school subdomains)
// disallows only /admin, /*lesson_plan and /userFiles, and asks Crawl-delay: 5.
// /api/ is unrestricted. politeFetch's floor is 2s, so this scraper adds its
// own gap to honor the full 5s between requests. Note that the district's asset
// host files.smartsites.parentsquare.com is Disallow: / and is never touched.
//
// The API returns correct DST-aware offsets in start_datetime for timed events
// ("2026-12-03T19:00:00-08:00" vs "2026-09-12T19:00:00-07:00"), so no timezone
// math is needed for those. All-day events give a bare "YYYY-MM-DD" instead,
// which is resolved to LA midnight via the shared laOffsetMinutes helper.

import { setTimeout as sleep } from "node:timers/promises";
import { laDateOffset, laOffsetMinutes } from "./civicplus-rss.ts";
import { resolveDocumentId } from "./document-linkage.ts";
import type { NewItemInput, ScraperDef } from "./types.ts";

export interface CvusdEvent {
	id?: string;
	title?: string;
	start_date?: string; // "2026-12-03"
	start_time?: string; // "19:00:00"
	start_datetime?: string; // full ISO w/ offset when timed, bare date when all-day
	end_datetime?: string;
	all_day?: boolean;
	description?: string;
	address?: string;
	link?: string; // relative: "/event_view?event_id=...&calIDref=..."
	calendar_name?: string;
}

export interface CvusdCalendar {
	host: string; // "www.chino.k12.ca.us" — no scheme
	calendarId: number;
	label: string; // reader-facing origin, stored in meta.calendar
	// The district calendar repeats the Board of Education meetings that
	// cvusd-board already ingests from the board's own listing (with agendas,
	// minutes and video). Those are dropped here so one meeting does not show up
	// twice in a brief, once as a meeting and once as a plain calendar event.
	dropBoardMeetings?: boolean;
}

// The district plus the four comprehensive high schools. Ids are the CMS's
// calendarApiId, read off each site's own calendar page (data-calendar="...")
// and confirmed live against the API on 2026-09-04.
export const CALENDARS: CvusdCalendar[] = [
	{
		host: "www.chino.k12.ca.us",
		calendarId: 134999,
		label: "CVUSD District Calendar",
		dropBoardMeetings: true,
	},
	{
		host: "chinohigh.chino.k12.ca.us",
		calendarId: 135000,
		label: "Chino High School",
	},
	{
		host: "donlugo.chino.k12.ca.us",
		calendarId: 135001,
		label: "Don Antonio Lugo High School",
	},
	{
		host: "ayala.chino.k12.ca.us",
		calendarId: 135002,
		label: "Ruben S. Ayala High School",
	},
	// Verified live and valid, but empty for the fall on 2026-09-04: a full-year
	// query returns 31 events that stop at 2026-08-10, so the school simply has
	// not posted its fall calendar yet. An empty calendar is noted, never thrown
	// on — only every calendar failing at once is treated as the API moving.
	{
		host: "chinohills.chino.k12.ca.us",
		calendarId: 135003,
		label: "Chino Hills High School",
	},
];

// robots.txt asks Crawl-delay: 5; politeFetch already enforces 2s per host, so
// this is the remainder. Each calendar is a different subdomain, but they are
// one server and one operator, so the delay is applied between all requests
// rather than per host. Overridable as a seam, not a knob: five calendars means
// four real pauses, and the test that drives run() has no business sleeping
// through 12s of production politeness. Unset in production, where the full 5s
// is the point.
function extraRequestGapMs(): number {
	return Number(process.env.CVT_CVUSD_GAP_MS ?? 3000);
}
// How far back and forward to ask for. Back one day so a late-morning run still
// sees an event that started this morning; forward far enough that a school
// musical announced a term ahead is already in the archive when it is announced.
const LOOKBACK_DAYS = 1;
const LOOKAHEAD_DAYS = 120;

// An all-day event carries no time, so "the day it happens" has to mean LA
// midnight — storing it as UTC midnight would put a 7am-PDT-offset event on the
// previous calendar day for every reader in Chino.
export function laMidnightIso(dateStr: string): string | null {
	const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return null;
	const naiveUtc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
	return new Date(naiveUtc - laOffsetMinutes(naiveUtc) * 60000).toISOString();
}

// The instant an event starts. Timed events already carry a correct offset from
// the API and are trusted verbatim; all-day events fall back to LA midnight.
export function eventStartIso(e: CvusdEvent): string | null {
	if (!e.all_day && e.start_datetime?.includes("T")) {
		const d = new Date(e.start_datetime);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}
	return e.start_date ? laMidnightIso(e.start_date) : null;
}

// Board of Education meetings belong to cvusd-board, which has the agenda,
// minutes and video for each one. Matched on the title the district calendar
// actually uses; a stricter match would miss a renamed special meeting, and a
// looser one would swallow school-site board presentations.
export function isBoardMeeting(title: string): boolean {
	return /^board of education meeting/i.test(title.trim());
}

export function eventToItem(
	e: CvusdEvent,
	cal: CvusdCalendar,
): Omit<NewItemInput, "document_id"> | null {
	const title = (e.title ?? "").replace(/\s+/g, " ").trim();
	const occurredAt = eventStartIso(e);
	// No title or no start instant means nothing a reader could act on, and an
	// id-less event cannot be given a stable identity.
	if (!title || !occurredAt || !e.id) return null;
	// The API's numeric id is per-event, not per-occurrence — the link carries a
	// separate eventDate — so a recurring event would collide on id alone.
	const externalId = `${e.id}:${e.start_date ?? occurredAt.slice(0, 10)}`;
	return {
		source_url: e.link
			? new URL(e.link, `https://${cal.host}`).toString()
			: `https://${cal.host}/`,
		item_type: "event",
		external_id: externalId,
		title,
		body: e.description?.trim() || null,
		occurred_at: occurredAt,
		meta: {
			host: cal.host,
			calendar: cal.label,
			calendarId: cal.calendarId,
			venue: e.address?.trim() || cal.label,
			allDay: e.all_day === true,
		},
	};
}

const scraper: ScraperDef = {
	key: "cvusd-calendar",
	name: "CVUSD calendars (district + high schools)",
	baseUrl: "https://www.chino.k12.ca.us",
	method: "api",
	async run(ctx) {
		const now = new Date();
		const startDate = laDateOffset(now, -LOOKBACK_DAYS);
		const endDate = laDateOffset(now, LOOKAHEAD_DAYS);
		let first = true;
		let totalStored = 0;
		const failures: string[] = [];

		for (const cal of CALENDARS) {
			if (!first) await sleep(extraRequestGapMs());
			first = false;
			const url =
				`https://${cal.host}/api/calendars/${cal.calendarId}/events` +
				`?start_date=${startDate}&end_date=${endDate}&view_source=event-slider`;
			const doc = await ctx.fetchDocument(url, {
				docType: "feed",
				title: `CVUSD calendar — ${cal.label}`,
			});

			// `| null` is not paranoia: "null" is valid JSON and JSON.parse
			// returns it happily, so the shape check below has to survive it.
			let parsed: {
				success?: boolean;
				data?: { events?: CvusdEvent[] };
			} | null;
			try {
				parsed = JSON.parse(doc.body.toString("utf8"));
			} catch (err) {
				failures.push(cal.label);
				ctx.note(
					`${cal.label}: response at ${url} did not parse as JSON: ${(err as Error).message}`,
				);
				continue;
			}
			// A school calendar CAN legitimately be empty over a holiday stretch,
			// so an empty list is a note, not a throw. What is not legitimate is
			// the envelope changing shape — that shows up as success !== true, or
			// as a body that parses but isn't an object at all ("null" is valid
			// JSON, and reading .data off it would throw past this scraper's
			// per-calendar error handling and abort the whole run).
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				parsed.success !== true
			) {
				failures.push(cal.label);
				ctx.note(
					`${cal.label}: API returned success=${String(parsed?.success)} at ${url} — ` +
						"the response envelope has probably changed.",
				);
				continue;
			}
			const events = parsed.data?.events ?? [];

			let stored = 0;
			let droppedBoard = 0;
			let unusable = 0;
			for (const e of events) {
				if (cal.dropBoardMeetings && isBoardMeeting(e.title ?? "")) {
					droppedBoard++;
					continue;
				}
				const item = eventToItem(e, cal);
				if (!item) {
					unusable++;
					continue;
				}
				ctx.insertItem({
					...item,
					document_id: resolveDocumentId(
						ctx,
						doc.documentId,
						item.external_id,
						item.item_type,
					),
				});
				stored++;
			}
			totalStored += stored;
			ctx.note(
				`${cal.label} (calendar ${cal.calendarId} on ${cal.host}): stored ${stored} of ` +
					`${events.length} event(s) for ${startDate}..${endDate}` +
					`${droppedBoard ? `, ${droppedBoard} Board of Education meeting(s) left to cvusd-board` : ""}` +
					`${unusable ? `, ${unusable} skipped for a missing title/date/id` : ""}.`,
			);
		}

		if (failures.length === CALENDARS.length) {
			// Every calendar failing at once is not a quiet day, it is the API
			// moving. Throwing is what run-one.ts reads as a failed run.
			throw new Error(
				`All ${CALENDARS.length} CVUSD calendars failed to return usable JSON — ` +
					"the /api/calendars/<id>/events endpoint or its envelope has probably changed.",
			);
		}
		if (failures.length > 0) {
			ctx.note(
				`Partial run: ${failures.length} of ${CALENDARS.length} calendars failed (${failures.join(", ")}).`,
			);
		}
		ctx.note(
			`${totalStored} event(s) stored across ${CALENDARS.length - failures.length} calendar(s). ` +
				"Endpoint is the district CMS's own unauthenticated JSON API, found by reading the " +
				"calendar page's bundled JS; no RSS or iCal exists anywhere on these sites, and " +
				"robots.txt restricts only /admin, /*lesson_plan and /userFiles (Crawl-delay: 5, honored).",
		);
	},
};

export default scraper;
