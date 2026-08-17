import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mapForecastPeriod } from "./nws-forecast.ts";

// Trimmed from a real api.weather.gov gridpoint forecast period shape.
const PERIOD = {
	number: 1,
	name: "Today",
	startTime: "2026-08-17T06:00:00-07:00",
	endTime: "2026-08-17T18:00:00-07:00",
	isDaytime: true,
	temperature: 94,
	temperatureUnit: "F",
	windSpeed: "5 to 10 mph",
	windDirection: "SW",
	shortForecast: "Sunny",
	detailedForecast: "Sunny, with a high near 94.",
	probabilityOfPrecipitation: { value: null },
};

const READER_URL =
	"https://forecast.weather.gov/MapClick.php?lat=33.99&lon=-117.69";

describe("mapForecastPeriod", () => {
	const item = mapForecastPeriod(PERIOD, "Chino", "SGX/47,73", READER_URL);

	test("returns null without a startTime (no stable identity possible)", () => {
		assert.equal(
			mapForecastPeriod({ number: 2 }, "Chino", "SGX/47,73", READER_URL),
			null,
		);
	});

	test("malformed timestamps degrade instead of throwing", () => {
		// toISOString() on an Invalid Date throws RangeError; one bad period
		// must not abort the whole run.
		assert.equal(
			mapForecastPeriod(
				{ number: 3, startTime: "not-a-date" },
				"Chino",
				"SGX/47,73",
				READER_URL,
			),
			null,
		);
		const badEnd = mapForecastPeriod(
			{ ...PERIOD, endTime: "not-a-date" },
			"Chino",
			"SGX/47,73",
			READER_URL,
		);
		assert.ok(badEnd);
		assert.equal((badEnd.meta as Record<string, unknown>).endTime, null);
	});

	test("identity embeds gridpoint + UTC start so both cities coexist", () => {
		assert.ok(item);
		assert.equal(item.external_id, "SGX/47,73:2026-08-17T13:00:00.000Z");
		assert.equal(item.item_type, "forecast_period");
		assert.equal(item.occurred_at, "2026-08-17T13:00:00.000Z");
	});

	test("cites the reader-facing MapClick page, not the JSON API", () => {
		assert.ok(item);
		assert.equal(item.source_url, READER_URL);
	});

	test("title and meta carry the brief-facing fields", () => {
		assert.ok(item);
		assert.equal(item.title, "Chino — Today: Sunny");
		assert.equal(item.body, "Sunny, with a high near 94.");
		const meta = item.meta as Record<string, unknown>;
		assert.equal(meta.temperature, 94);
		assert.equal(meta.windSpeed, "5 to 10 mph");
		assert.equal(meta.probabilityOfPrecipitation, null);
		assert.equal(meta.endTime, "2026-08-18T01:00:00.000Z");
	});
});
