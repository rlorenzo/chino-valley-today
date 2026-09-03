import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	distanceKm,
	mapQuake,
	stripGenerated,
	windowStart,
} from "./usgs-quakes.ts";

// The 2026-09-02 event verbatim from the FDSN response, trimmed to the fields
// the mapper reads. This is the quake that started the task: pushed to phones
// as M3.36, settled at M3.2 `reviewed` eleven hours later.
const ONTARIO = {
	id: "ci41540608",
	properties: {
		mag: 3.2,
		place: "6 km SE of Ontario, CA",
		time: 1788352632690,
		updated: 1788394057544,
		url: "https://earthquake.usgs.gov/earthquakes/eventpage/ci41540608",
		felt: 710,
		cdi: 3.3,
		mmi: 3.841,
		alert: null,
		status: "reviewed",
		tsunami: 0,
		sig: 392,
		net: "ci",
		magType: "ml",
		title: "M 3.2 - 6 km SE of Ontario, CA",
	},
	geometry: { coordinates: [-117.589166666667, 34.0145, 6.14] },
};

// Loma Linda: inside the 50 km search ring, 45 km out, and not Chino news.
const LOMA_LINDA = {
	id: "ci40123456",
	properties: {
		mag: 3.23,
		place: "7 km SE of Loma Linda, CA",
		time: 1778000000000,
		url: "https://earthquake.usgs.gov/earthquakes/eventpage/ci40123456",
		status: "reviewed",
	},
	geometry: { coordinates: [-117.219, 34.023, 12.0] },
};

describe("distanceKm", () => {
	test("matches the known Chino to Chino Hills separation", () => {
		// The two city centers the pipeline uses are ~4.5 km apart.
		const km = distanceKm(33.99, -117.69, 33.95, -117.73);
		assert.ok(km > 4 && km < 6, `expected ~4.5 km, got ${km}`);
	});

	test("is zero for a point against itself", () => {
		assert.equal(distanceKm(33.97, -117.71, 33.97, -117.71), 0);
	});
});

describe("mapQuake", () => {
	const item = mapQuake(ONTARIO);

	test("cites the USGS event page, keyed on the event id", () => {
		assert.ok(item);
		assert.equal(
			item.source_url,
			"https://earthquake.usgs.gov/earthquakes/eventpage/ci41540608",
		);
		assert.equal(item.external_id, "ci41540608");
		assert.equal(item.item_type, "alert");
		assert.equal(item.occurred_at, new Date(1788352632690).toISOString());
	});

	test("states distance from Chino ourselves and quotes USGS place verbatim", () => {
		assert.ok(item);
		// USGS never says Chino; the ~10 km is ours and is presented as ours.
		assert.equal(
			item.title,
			"M 3.2 earthquake, 10 km from Chino (6 km SE of Ontario, CA)",
		);
	});

	test("renders no body — Fire & safety is title and link only", () => {
		assert.ok(item);
		assert.equal(item.body, null);
	});

	test("flags a nearby event as Chino-relevant with the felt count", () => {
		assert.ok(item);
		const meta = item.meta as Record<string, unknown>;
		assert.equal(meta.chinoRelevant, true);
		assert.equal(meta.nearestCity, "Chino");
		assert.equal(meta.felt, 710);
		assert.equal(meta.magnitude, 3.2);
		assert.equal(meta.preliminary, false);
	});

	test("does not flag a same-magnitude event 45 km away", () => {
		const far = mapQuake(LOMA_LINDA);
		assert.ok(far);
		const meta = far.meta as Record<string, unknown>;
		assert.equal(meta.chinoRelevant, false);
		// It is still ingested: the record keeps what the region felt.
		assert.equal(far.external_id, "ci40123456");
	});

	test("a large quake is relevant regardless of distance", () => {
		const big = mapQuake({
			...LOMA_LINDA,
			properties: { ...LOMA_LINDA.properties, mag: 4.6 },
		});
		assert.ok(big);
		assert.equal((big.meta as Record<string, unknown>).chinoRelevant, true);
	});

	test("says Preliminary until USGS marks the event reviewed", () => {
		const fresh = mapQuake({
			...ONTARIO,
			properties: { ...ONTARIO.properties, mag: 3.36, status: "automatic" },
		});
		assert.ok(fresh?.title);
		assert.match(
			fresh.title,
			/^Preliminary M 3\.4 earthquake, 10 km from Chino/,
		);
		assert.equal((fresh.meta as Record<string, unknown>).preliminary, true);
	});

	test("skips features it cannot describe honestly", () => {
		const p = ONTARIO.properties;
		// No magnitude, no claim to make.
		assert.equal(
			mapQuake({ ...ONTARIO, properties: { ...p, mag: null } }),
			null,
		);
		// No event page, no citation.
		assert.equal(
			mapQuake({ ...ONTARIO, properties: { ...p, url: null } }),
			null,
		);
		// No time, no day to file it under.
		assert.equal(
			mapQuake({ ...ONTARIO, properties: { ...p, time: null } }),
			null,
		);
		// No coordinates, no distance from Chino.
		assert.equal(mapQuake({ ...ONTARIO, geometry: { coordinates: [] } }), null);
		assert.equal(mapQuake({}), null);
	});
});

describe("stripGenerated", () => {
	test("removes the per-request stamp and nothing else", () => {
		const a = stripGenerated(
			Buffer.from(
				'{"metadata":{"generated":1788394885000,"count":2},"features":[]}',
			),
		).toString();
		const b = stripGenerated(
			Buffer.from(
				'{"metadata":{"generated":1788398888000,"count":2},"features":[]}',
			),
		).toString();
		// Two requests an hour apart hash to one archived document.
		assert.equal(a, b);
		assert.match(a, /"count":2/);
		// The redaction announces itself: nothing in the archive can be mistaken
		// for a value USGS actually sent.
		assert.match(a, /"generated":"STRIPPED-BY-CHINO-VALLEY-TODAY"/);
		// Still valid JSON, since the scraper parses the stripped bytes.
		assert.deepEqual(JSON.parse(a).features, []);
	});
});

describe("windowStart", () => {
	test("is a UTC date, so the query URL only changes once a day", () => {
		const s = windowStart(new Date("2026-09-02T12:34:56Z"), 7);
		assert.equal(s, "2026-08-26");
	});
});
