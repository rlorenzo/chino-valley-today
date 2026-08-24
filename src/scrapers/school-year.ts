// Both athletics sources index their data by school year, named for the year it
// starts in: 2026 means the 2026-27 season, which begins in July.
//
// It has to be read off the school's own timezone. `toISOString()` west of UTC
// reports the next calendar day every evening, which rolls the season over on
// the afternoon of June 30 and asks each source for a year of games that does
// not exist yet.

const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/**
 * Pacific calendar date as YYYY-MM-DD.
 *
 * Assembled from formatToParts rather than read off the formatted string. That
 * en-CA prints YYYY-MM-DD is a convention of the current locale data, not
 * anything the spec promises, and the failure if it ever changed would be
 * silent: schoolYearStart slices positions 0-3 and 5-6 out of this, so a
 * different order would ask both sources for a season that does not exist and
 * quietly ingest nothing. The parts are named, so the order cannot matter.
 */
export function pacificDay(d: Date): string {
	const parts = PACIFIC_DAY.formatToParts(d);
	const at = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
		parts.find((p) => p.type === type)?.value;
	const year = at("year");
	const month = at("month");
	const day = at("day");
	// Throwing rather than substituting a blank. This helper exists to keep a
	// rollover bug from being silent, so a missing part must not be allowed to
	// produce "--" and be sliced into a nonsense year further down.
	if (!year || !month || !day) {
		throw new Error(
			`pacificDay: Intl returned no year/month/day for ${d.toISOString()}`,
		);
	}
	return `${year}-${month}-${day}`;
}

/**
 * The start year of the school year a YYYY-MM-DD calendar date falls in:
 * "2026" for everything from 2026-07-01 through 2027-06-30.
 */
export function schoolYearStart(day: string): string {
	// Positional slicing with no guard turns any other input into "NaN", and a
	// scraper then asks its source for the NaN season: both athletics sources
	// answer that with an empty table, so the run reports success having
	// ingested nothing. Loud beats a season that does not exist.
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
		throw new Error(
			`schoolYearStart: expected YYYY-MM-DD, got ${JSON.stringify(day)}`,
		);
	}
	const year = Number(day.slice(0, 4));
	const startsThisYear = Number(day.slice(5, 7)) >= 7;
	return String(year - (startsThisYear ? 0 : 1));
}
