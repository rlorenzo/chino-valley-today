// What a run of ZERO items means, per source.
//
// `checkDegradedSources` (pipeline/brief-health.ts) flags a source that records
// three straight runs of success-with-0-items. That rule is only sound where 0
// items means something went wrong. For a weekly student paper between issues,
// a drop directory nobody has added to, or a forecast zone with no active
// weather alert, 0 is the correct answer, and flagging it would teach an
// operator to ignore the alarm.
//
// So every scraper declares which it is, here, and quiet-policy.test.ts asserts
// this map covers the registry exactly — no key missing, none left over. A new
// scraper cannot join without someone deciding what quiet means for it. That is
// the lesson of chinohills-swagit, which ingested nothing for six days while
// every watchdog called it healthy: the watchdog was only ever looking at the
// six press outlets, so a transcript source posting clean 0-item successes was
// not so much unwatched as unwatchable.
//
// Note that items_count counts items SEEN, not items new (context.ts), so a
// source re-reading the same unchanged listing still counts them every run. 0
// means nothing was extracted at all.
//
// The value is the reason quiet is expected — printed by the watchdog when it
// declines to flag a source — or null where this source must produce items on
// every run.
export const QUIET_IS_HEALTHY: Record<string, string | null> = {
	// --- Civic records. An agenda listing, a meeting archive and a city news
	// feed are archives: they do not empty because a week was slow. ---
	"chino-legistar": null,
	"chino-agendacenter": null,
	"chino-news-rss": null,
	"chinohills-agendas": null,
	"chinohills-news-rss": null,
	"chinohills-swagit": null,
	"cvusd-board": null,

	// Both caption scrapers re-read the most recent meeting video each run, so
	// they keep counting the same segments until a newer video appears.
	"youtube-captions": null,
	"chino-youtube-captions": null,

	// --- Weather. The forecast always exists; the alert feed usually should
	// not have anything in it. ---
	"nws-forecast": null,
	"nws-alerts":
		"most days carry no active alert for the zone, and an empty feed is what a safe day looks like",

	// --- Agencies. ---
	"sbsheriff-news": null,
	"sbsheriff-nixle-mail":
		"Nixle alerts arrive as email when the Sheriff sends one; most runs find no new mail",
	"sbcfire-news": null,
	"cvfd-news": null,
	"abc-licenses":
		"a weekly ABC report often lists no Chino or Chino Hills license activity at all",

	// --- Event calendars. Each ingests a whole published calendar, verified
	// non-empty on probe day and re-counted every run. ---
	"sbclib-events": null,
	"sbparks-events": null,
	"cbwcd-events": null,
	"yanksair-events": null,

	// --- Secondary press. The two dailies/weeklies must produce; the student
	// papers and NBC4 are quiet by design. ---
	"dailybulletin-news": null,
	"quest-news": "a student paper is dormant between issues and over the summer",
	"bulldogtimes-news":
		"a student paper is dormant between issues and over the summer",
	"breeze-news":
		"a student paper is dormant between issues and over the summer",
	"nbc4-news":
		"a regional outlet's Chino keyword filter matches nothing on most days",

	// --- High school sports. Every one of these reads a 14-day-back /
	// 21-day-ahead window, which is genuinely empty between seasons. ---
	"chinohigh-sports": "no fixtures fall in the window between seasons",
	"ayala-sports": "no fixtures fall in the window between seasons",
	"donlugo-sports": "no fixtures fall in the window between seasons",
	"chinohills-sports": "no fixtures fall in the window between seasons",

	// --- Seismic. ---
	"usgs-quakes":
		"the 50 km ring averages 27 events a year, so an empty 7-day window is the ordinary state and a busy one is the alarming case",

	// --- Hand-dropped minutes. ---
	"chinohills-minutes":
		"the drop directory is empty between hand-pulls, which is its normal state",
};
