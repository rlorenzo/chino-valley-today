import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeScraperContext } from "./__fixtures__/fake-context.ts";
import { laDateOffset } from "./civicplus-rss.ts";
import scraper, {
	CALENDARS,
	type CvusdCalendar,
	type CvusdEvent,
	eventStartIso,
	eventToItem,
	isBoardMeeting,
	laMidnightIso,
} from "./cvusd-calendar.ts";

// Trimmed from a live ayala.chino.k12.ca.us API response (2026-09-04), plus one
// Board of Education row copied from the district feed to exercise the drop.
const FIXTURE: { success: boolean; data: { events: CvusdEvent[] } } =
	JSON.parse(
		readFileSync(
			join(import.meta.dirname, "__fixtures__/cvusd-calendar.json"),
			"utf8",
		),
	);
const EVENTS = FIXTURE.data.events;

const AYALA: CvusdCalendar = {
	host: "ayala.chino.k12.ca.us",
	calendarId: 135002,
	label: "Ruben S. Ayala High School",
};
describe("laMidnightIso", () => {
	test("resolves an all-day date to LA midnight, not UTC midnight", () => {
		// PDT in September: midnight local is 07:00Z.
		assert.equal(laMidnightIso("2026-09-07"), "2026-09-07T07:00:00.000Z");
		// PST in December: midnight local is 08:00Z.
		assert.equal(laMidnightIso("2026-12-03"), "2026-12-03T08:00:00.000Z");
	});

	test("returns null for anything that is not a bare date", () => {
		assert.equal(laMidnightIso("2026-09-07T19:00:00-07:00"), null);
		assert.equal(laMidnightIso(""), null);
	});
});

describe("eventStartIso", () => {
	test("trusts the API's own offset for a timed event", () => {
		const dance = EVENTS.find((e) => e.title === "Homecoming Dance");
		assert.equal(
			eventStartIso(dance as CvusdEvent),
			"2026-09-13T02:00:00.000Z",
		);
	});

	test("handles the PST side of the year correctly", () => {
		const madrigal = EVENTS.find((e) => e.start_date === "2026-12-03");
		// 7pm PST on Dec 3 is 03:00Z on Dec 4.
		assert.equal(
			eventStartIso(madrigal as CvusdEvent),
			"2026-12-04T03:00:00.000Z",
		);
	});

	test("falls back to LA midnight for an all-day event", () => {
		const labor = EVENTS.find((e) => e.all_day === true);
		assert.equal(
			eventStartIso(labor as CvusdEvent),
			"2026-09-07T07:00:00.000Z",
		);
	});

	test("returns null when there is no usable start at all", () => {
		assert.equal(eventStartIso({ title: "x" }), null);
	});
});

describe("isBoardMeeting", () => {
	test("matches the district calendar's board meeting rows", () => {
		assert.equal(isBoardMeeting("Board of Education Meeting"), true);
		assert.equal(
			isBoardMeeting("  board of education meeting (special)"),
			true,
		);
	});

	test("does not swallow other board-adjacent events", () => {
		assert.equal(isBoardMeeting("Board Presentation by Ayala Choir"), false);
		assert.equal(isBoardMeeting("Winter Music Concert"), false);
	});
});

describe("eventToItem", () => {
	const madrigals = EVENTS.filter((e) => e.title === "Madrigal Feast (MPR)");

	test("builds an absolute item-level source_url from the relative link", () => {
		const item = eventToItem(madrigals[0], AYALA);
		assert.equal(
			item?.source_url,
			"https://ayala.chino.k12.ca.us/event_view?event_id=1282187&calIDref=135002&eventDate=2026-12-03&feed_type=ss",
		);
	});

	test("gives two performances of one show distinct identities", () => {
		const a = eventToItem(madrigals[0], AYALA)?.external_id;
		const b = eventToItem(madrigals[1], AYALA)?.external_id;
		assert.notEqual(a, b);
		assert.match(a ?? "", /:2026-12-03$/);
		assert.match(b ?? "", /:2026-12-04$/);
	});

	test("records the calendar it came from and flags all-day events", () => {
		const labor = EVENTS.find((e) => e.all_day === true) as CvusdEvent;
		const meta = eventToItem(labor, AYALA)?.meta as Record<string, unknown>;
		assert.equal(meta.calendar, "Ruben S. Ayala High School");
		assert.equal(meta.calendarId, 135002);
		assert.equal(meta.allDay, true);
		// No address on this row, so the venue falls back to the school name.
		assert.equal(meta.venue, "Ruben S. Ayala High School");
	});

	test("returns null rather than storing an event with no id", () => {
		assert.equal(eventToItem({ ...madrigals[0], id: undefined }, AYALA), null);
	});

	test("returns null rather than storing an untitled event", () => {
		assert.equal(eventToItem({ ...madrigals[0], title: "   " }, AYALA), null);
	});
});

describe("run", () => {
	// The gap between calendars is production politeness, not behaviour under
	// test; sleeping through 4x3s here would quadruple the suite's runtime.
	const withNoGap = async (fn: () => Promise<void>) => {
		const prev = process.env.CVT_CVUSD_GAP_MS;
		process.env.CVT_CVUSD_GAP_MS = "0";
		try {
			await fn();
		} finally {
			if (prev === undefined) delete process.env.CVT_CVUSD_GAP_MS;
			else process.env.CVT_CVUSD_GAP_MS = prev;
		}
	};

	/** The URL run() builds for one calendar, for today's query window. */
	const urlFor = (cal: CvusdCalendar) => {
		const now = new Date();
		return (
			`https://${cal.host}/api/calendars/${cal.calendarId}/events` +
			`?start_date=${laDateOffset(now, -1)}&end_date=${laDateOffset(now, 120)}` +
			"&view_source=event-slider"
		);
	};

	/** Every calendar answering with `bodies[host]`, defaulting to empty. */
	const responsesFor = (bodies: Record<string, string>) =>
		Object.fromEntries(
			CALENDARS.map((cal) => [
				urlFor(cal),
				bodies[cal.host] ??
					JSON.stringify({ success: true, data: { events: [] } }),
			]),
		);

	test("queries every calendar and stores what they return", async () => {
		await withNoGap(async () => {
			const { ctx, items, requested } = fakeScraperContext(
				responsesFor({ "ayala.chino.k12.ca.us": JSON.stringify(FIXTURE) }),
			);
			await scraper.run(ctx);
			assert.equal(requested.length, CALENDARS.length);
			// The fixture's board meeting is on a school calendar here, so nothing
			// is dropped for that reason: every well-formed row is stored.
			const usable = EVENTS.filter((e) => eventToItem(e, AYALA) !== null);
			assert.equal(items.length, usable.length);
			assert.ok(items.every((i) => i.item_type === "event"));
			const madrigal = items.find((i) => i.title === "Madrigal Feast (MPR)");
			assert.ok(madrigal);
			assert.equal(
				(madrigal.meta as { calendar?: string }).calendar,
				"Ruben S. Ayala High School",
			);
		});
	});

	test("drops Board of Education meetings from the district calendar only", async () => {
		await withNoGap(async () => {
			const body = JSON.stringify(FIXTURE);
			const board = EVENTS.find(
				(e) => e.title === "Board of Education Meeting",
			);
			assert.ok(board, "fixture should carry a board meeting row");

			// Same payload served as the district: the board row is left to
			// cvusd-board, which has its agenda, minutes and video.
			const district = fakeScraperContext(
				responsesFor({ "www.chino.k12.ca.us": body }),
			);
			await scraper.run(district.ctx);
			assert.equal(
				district.items.filter((i) => isBoardMeeting(i.title ?? "")).length,
				0,
			);
			assert.ok(
				district.notes.some((n) =>
					n.includes("Board of Education meeting(s) left to cvusd-board"),
				),
			);

			// The same payload on a school calendar keeps it.
			const school = fakeScraperContext(
				responsesFor({ "ayala.chino.k12.ca.us": body }),
			);
			await scraper.run(school.ctx);
			assert.equal(
				school.items.filter((i) => isBoardMeeting(i.title ?? "")).length,
				1,
			);
		});
	});

	test("notes a bad envelope and keeps going on the other calendars", async () => {
		await withNoGap(async () => {
			const { ctx, items, notes } = fakeScraperContext(
				responsesFor({
					"www.chino.k12.ca.us": JSON.stringify({ success: false }),
					// Valid JSON, but not an object: JSON.parse returns null and
					// reading .data off it would abort the whole run.
					"chinohigh.chino.k12.ca.us": "null",
					"ayala.chino.k12.ca.us": JSON.stringify(FIXTURE),
				}),
			);
			await scraper.run(ctx);
			assert.ok(items.length > 0, "the healthy calendars still store events");
			assert.equal(
				notes.filter((n) =>
					n.includes("response envelope has probably changed"),
				).length,
				2,
			);
			assert.ok(notes.some((n) => n.includes("Partial run: 2 of 5")));
		});
	});

	test("throws when every calendar fails, rather than reporting a quiet day", async () => {
		await withNoGap(async () => {
			// Every calendar answers with HTML instead of JSON — what a redesigned
			// or relocated endpoint looks like from here.
			const { ctx } = fakeScraperContext(
				Object.fromEntries(
					CALENDARS.map((cal) => [urlFor(cal), "<html>Not Found</html>"]),
				),
			);
			await assert.rejects(
				() => scraper.run(ctx),
				/All 5 CVUSD calendars failed/,
			);
		});
	});
});
